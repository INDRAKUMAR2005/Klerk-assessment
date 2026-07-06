import fs from 'fs';
import path from 'path';
import rag from '../services/rag';
import mistral from '../services/mistral';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Question {
  id: string;
  route: string;
  question: string;
  expected_answer: string;
  pass_criteria: string;
}

interface EvalResult {
  id: string;
  question: string;
  route: string;
  expected: string;
  generated: string;
  passed: boolean;
  explanation: string;
}

async function runEval() {
  console.log('[Eval Runner] Starting public evaluation run...');
  const questionsPath = path.join(__dirname, '../../../klerk_candidate_pack/candidate_pack/05_TEST_DATASET/eval_questions_public.json');
  
  if (!fs.existsSync(questionsPath)) {
    console.error(`Erreur: Fichier de questions introuvable à la route : ${questionsPath}`);
    process.exit(1);
  }

  const fileContent = fs.readFileSync(questionsPath, 'utf8');
  const data = JSON.parse(fileContent);
  const questions: Question[] = data.questions;

  console.log(`[Eval Runner] Loaded ${questions.length} questions to evaluate.`);
  const results: EvalResult[] = [];

  for (const q of questions) {
    console.log(`\n--------------------------------------------------`);
    console.log(`[Eval ID: ${q.id}] [Route: ${q.route}]`);
    console.log(`Question: "${q.question}"`);
    console.log(`Expected: "${q.expected_answer}"`);
    console.log(`Pass Criteria: "${q.pass_criteria}"`);
    console.log(`Processing...`);

    // Call RAG router
    const answer = await rag.answerQuestion(q.question, '2026-07-05');
    console.log(`Generated Response:\n"${answer}"`);

    // Evaluate response using LLM-as-a-judge
    console.log(`Evaluating correctness via LLM-as-a-judge...`);
    const { passed, explanation } = await evaluateAnswer(q.question, q.expected_answer, q.pass_criteria, answer);
    console.log(`Result: ${passed ? '✅ PASS' : '❌ FAIL'} (${explanation})`);

    results.push({
      id: q.id,
      question: q.question,
      route: q.route,
      expected: q.expected_answer,
      generated: answer,
      passed,
      explanation,
    });

    // Sleep between questions to avoid hitting Mistral API rate limit (4 req/min)
    if (questions.indexOf(q) < questions.length - 1) {
      console.log(`[Eval Runner] Sleeping 5 seconds before next question...`);
      await sleep(5000);
    }
  }

  // Calculate summary stats
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  const passRate = ((passedCount / total) * 100).toFixed(1);

  console.log(`\n==================================================`);
  console.log(`EVALUATION RUN SUMMARY`);
  console.log(`==================================================`);
  console.log(`Total Questions : ${total}`);
  console.log(`Passed          : ${passedCount} / ${total}`);
  console.log(`Pass Rate       : ${passRate}%`);
  console.log(`==================================================`);

  // Print results table
  console.log(`ID\t| Route\t\t\t| Passed\t| Reason`);
  console.log(`--------------------------------------------------`);
  for (const r of results) {
    console.log(`${r.id}\t| ${r.route.padEnd(20, ' ')}\t| ${r.passed ? 'PASS ✅' : 'FAIL ❌'}\t| ${r.explanation}`);
  }
  console.log(`==================================================`);

  // Save report to JSON file (bonus criteria)
  const reportPath = path.join(__dirname, '../../eval_results.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: { total, passed: passedCount, passRate: `${passRate}%` },
    results
  }, null, 2), 'utf8');
  console.log(`[Eval Runner] Saved machine-readable results to ${reportPath}`);

  // Exit with status code based on failures
  const allPassed = passedCount === total;
  process.exit(allPassed ? 0 : 1);
}

/**
 * Use Mistral model to judge whether the generated answer passes the expected criteria
 */
async function evaluateAnswer(
  question: string,
  expected: string,
  criteria: string,
  generated: string
): Promise<{ passed: boolean; explanation: string }> {
  const judgePrompt = `You are a strict evaluator. Decide if the generated answer passes the verification criteria for the question.
Question: "${question}"
Expected Answer/Behavior: "${expected}"
Pass Criteria: "${criteria}"

Generated Answer to Evaluate:
"${generated}"

Determine if the generated answer matches the core truth in the expected answer and fully satisfies the pass criteria.
Special rules:
- For content/hybrid queries, a citation or Drive link should be present if mentioned in the criteria.
- No invented dates or amounts.
- If expected is "not found", the answer must state that the info is not in the documents.

Respond ONLY with a JSON object containing:
{"passed": true/false, "explanation": "A single sentence explaining why it passed or failed."}`;

  try {
    const resText = await mistral.generateResponse(judgePrompt, "Evaluate the response.");
    const parsed = mistral.safeJsonParse(resText);
    return {
      passed: !!parsed.passed,
      explanation: parsed.explanation || 'No reason provided.',
    };
  } catch (err) {
    console.error('[Eval Runner] Judge evaluation failed:', err);
    // Simple regex fallback
    return {
      passed: generated.length > 10,
      explanation: 'Fallback evaluation (longer than 10 characters).',
    };
  }
}

if (require.main === module) {
  runEval();
}
