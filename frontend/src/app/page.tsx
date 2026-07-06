"use client";

import { useEffect, useState } from "react";

// Get backend URL from environment or fallback to localhost
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

interface Document {
  id: string;
  fileName: string;
  channel: "whatsapp" | "gmail";
  status: string;
  docType: string | null;
  supplierName: string | null;
  totalTtc: number | null;
  docDate: string | null;
  dueDate: string | null;
  driveLink: string | null;
  minConfidence: number | null;
  createdAt: string;
}

interface Anomaly {
  id: string;
  fileName: string;
  supplierName: string | null;
  totalTtc: number | null;
  dueDate: string | null;
  driveLink: string | null;
  status: string;
  vatAnomalyFlag: boolean;
}

interface Stat {
  docType: string | null;
  count: number;
  totalTtc: number;
}

export default function Dashboard() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [stats, setStats] = useState<Stat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Search & filter states
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  // Recap trigger states
  const [recapPeriod, setRecapPeriod] = useState("");
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapSuccess, setRecapSuccess] = useState("");
  const [recapError, setRecapError] = useState("");

  // Load stats and documents
  const fetchData = async () => {
    try {
      setLoading(true);
      const [docsRes, anomaliesRes, statsRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/documents`),
        fetch(`${BACKEND_URL}/api/anomalies`),
        fetch(`${BACKEND_URL}/api/stats`),
      ]);

      if (!docsRes.ok || !anomaliesRes.ok || !statsRes.ok) {
        throw new Error("Erreur lors de la récupération des données de l'API Klerk.");
      }

      const docsData = await docsRes.json();
      const anomaliesData = await anomaliesRes.json();
      const statsData = await statsRes.json();

      setDocuments(docsData);
      setAnomalies(anomaliesData);
      setStats(statsData);
      setError("");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Impossible de se connecter au serveur backend Klerk.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Default recap period to previous month
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const yyyy = d.getFullYear();
    const mm = (d.getMonth() + 1).toString().padStart(2, "0");
    setRecapPeriod(`${yyyy}-${mm}`);
  }, []);

  const handleTriggerRecap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}-\d{2}$/.test(recapPeriod)) {
      setRecapError("Le format doit être YYYY-MM (ex: 2026-06)");
      return;
    }

    try {
      setRecapLoading(true);
      setRecapSuccess("");
      setRecapError("");

      const res = await fetch(`${BACKEND_URL}/api/recap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: recapPeriod }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Une erreur est survenue lors de l'envoi du récapitulatif.");
      }

      setRecapSuccess(data.message);
    } catch (err: any) {
      setRecapError(err.message);
    } finally {
      setRecapLoading(false);
    }
  };

  // Format Helper: Cents to Euro string (e.g. 124680 -> 1 246,80 €)
  const formatEuro = (cents: number | null) => {
    if (cents === null || cents === undefined) return "-";
    return (cents / 100).toLocaleString("fr-FR", {
      style: "currency",
      currency: "EUR",
    });
  };

  // Format Helper: DB Date to French display
  const formatDateFr = (dateStr: string | null) => {
    if (!dateStr) return "-";
    return dateStr.split("-").reverse().join("/");
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "filed":
        return <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Classé</span>;
      case "pending_confirmation":
        return <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">En attente</span>;
      case "ocr_done":
      case "extracted":
        return <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200">OCR / Extrait</span>;
      case "duplicate_ignored":
        return <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-red-50 text-red-700 border border-red-200">Doublon</span>;
      case "rejected":
        return <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-rose-50 text-rose-700 border border-rose-200">Rejeté</span>;
      default:
        return <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-slate-100 text-slate-700 border border-slate-200">{status}</span>;
    }
  };

  const getCategoryLabel = (type: string | null) => {
    switch (type) {
      case "supplier_invoice": return "Facture Fournisseur";
      case "receipt": return "Ticket de caisse";
      case "quote": return "Devis Client";
      case "delivery_note": return "Bon de livraison";
      default: return "Autre / Inconnu";
    }
  };

  // Filtered documents list
  const filteredDocs = documents.filter((doc) => {
    const matchesSearch =
      (doc.supplierName || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      doc.fileName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = typeFilter === "all" || doc.docType === typeFilter;
    return matchesSearch && matchesType;
  });

  // Calculate stats sums
  const totalExpensesCents = stats
    .filter(s => s.docType === 'supplier_invoice' || s.docType === 'receipt')
    .reduce((acc, s) => acc + s.totalTtc, 0);

  const totalDocumentsCount = stats.reduce((acc, s) => acc + s.count, 0);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans antialiased selection:bg-red-600 selection:text-white">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-50 px-6 py-4 shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-red-600 to-rose-600 flex items-center justify-center shadow-md">
              <span className="font-extrabold text-lg text-white">K</span>
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900 flex items-center gap-2">
                KLERK <span className="text-[10px] bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 rounded-md font-mono font-bold">OPS CONTROL</span>
              </h1>
              <p className="text-xs text-slate-500 font-medium">Assistant Administratif Intelligent pour Artisans</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button
              onClick={fetchData}
              className="p-2 rounded-xl bg-white border border-slate-200 text-slate-600 hover:text-red-600 hover:border-red-200 hover:bg-red-50/20 transition-all flex items-center gap-2 text-xs font-semibold shadow-sm"
              title="Rafraîchir"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.228 10H18.228" />
              </svg>
              Rafraîchir
            </button>
            
            <div className="text-[11px] text-slate-600 border border-slate-200 bg-white rounded-xl px-3 py-2 flex items-center gap-2 shadow-sm font-medium">
              <span className="w-2 h-2 rounded-full bg-red-600 animate-ping"></span>
              <span>Connecté : {BACKEND_URL}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 flex flex-col gap-6">
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 text-red-800 rounded-2xl flex items-center gap-3 shadow-sm">
            <svg className="w-5 h-5 text-red-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="text-xs font-semibold">{error}</div>
          </div>
        )}

        {/* Stats Grid */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 p-5 rounded-2xl relative overflow-hidden shadow-sm hover:border-red-200 transition-all">
            <div className="absolute top-0 right-0 w-24 h-24 bg-red-50/20 rounded-full blur-xl"></div>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider">Total Dépenses</p>
            <p className="text-2xl font-black mt-2 text-red-600">{formatEuro(totalExpensesCents)}</p>
            <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400 font-medium">
              <span>Factures & Recettes</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-5 rounded-2xl relative overflow-hidden shadow-sm hover:border-red-200 transition-all">
            <div className="absolute top-0 right-0 w-24 h-24 bg-red-50/20 rounded-full blur-xl"></div>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider">Pièces Ingestées</p>
            <p className="text-2xl font-black mt-2 text-slate-900">{totalDocumentsCount}</p>
            <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400 font-medium">
              <span>{documents.filter(d => d.channel === 'whatsapp').length} WhatsApp • {documents.filter(d => d.channel === 'gmail').length} Gmail</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-5 rounded-2xl relative overflow-hidden shadow-sm hover:border-red-200 transition-all">
            <div className="absolute top-0 right-0 w-24 h-24 bg-red-50/20 rounded-full blur-xl"></div>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider">En Attente Validation</p>
            <p className="text-2xl font-black mt-2 text-amber-600">
              {documents.filter(d => d.status === 'pending_confirmation').length}
            </p>
            <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400 font-medium">
              <span>Action de l&apos;artisan requise</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-5 rounded-2xl relative overflow-hidden shadow-sm hover:border-red-200 transition-all">
            <div className="absolute top-0 right-0 w-24 h-24 bg-red-50/20 rounded-full blur-xl"></div>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider">Anomalies Détectées</p>
            <p className="text-2xl font-black mt-2 text-red-600">{anomalies.length}</p>
            <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400 font-medium">
              <span>TVA incohérente, retards ou doublons</span>
            </div>
          </div>
        </section>

        {/* Center Grid: Anomalies & Trigger recap */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Anomalies List */}
          <section className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 shadow-sm">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h2 className="text-xs font-black text-slate-900 tracking-wider uppercase flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-600"></span>
                ANOMALIES ET POINTS DE VIGILANCE
              </h2>
              <span className="text-[10px] font-bold px-2 py-0.5 bg-red-50 text-red-700 border border-red-200 rounded-md">
                {anomalies.length} ALERTE(S)
              </span>
            </div>

            {anomalies.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-8 text-slate-400 text-xs font-semibold">
                <svg className="w-8 h-8 text-emerald-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Aucune anomalie comptable détectée.
              </div>
            ) : (
              <div className="flex flex-col gap-3 max-h-[260px] overflow-y-auto pr-1">
                {anomalies.map((anom) => {
                  let badge = "Alerte";
                  let reason = "";
                  let color = "border-slate-200 bg-slate-50 text-slate-700";
                  
                  if (anom.status === "duplicate_ignored") {
                    badge = "Doublon";
                    reason = "Ce document a été identifié comme doublon et ignoré.";
                    color = "bg-orange-50 border-orange-200 text-orange-800";
                  } else if (anom.vatAnomalyFlag) {
                    badge = "TVA Incohérente";
                    reason = "Écart supérieur à 0,05 € calculé entre le montant HT et la TVA déclarée.";
                    color = "bg-red-50 border-red-200 text-red-800";
                  } else if (anom.dueDate && new Date(anom.dueDate) < new Date()) {
                    badge = "Retard Facture";
                    reason = `L'échéance de paiement est dépassée depuis le ${formatDateFr(anom.dueDate)}.`;
                    color = "bg-red-50 border-red-200 text-red-800";
                  }

                  return (
                    <div key={anom.id} className={`p-3 rounded-xl border flex flex-col gap-1 text-xs ${color} shadow-sm`}>
                      <div className="flex justify-between items-center">
                        <span className="font-bold uppercase tracking-wider text-[9px] px-2 py-0.5 rounded bg-white border border-current/25">
                          {badge}
                        </span>
                        {anom.driveLink && (
                          <a
                            href={anom.driveLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-red-600 hover:text-red-700 font-bold flex items-center gap-1 hover:underline"
                          >
                            Consulter la pièce ↗
                          </a>
                        )}
                      </div>
                      <p className="font-bold text-slate-800 mt-1">{anom.fileName}</p>
                      <p className="text-slate-500 text-[11px] font-medium">{reason}</p>
                      {anom.supplierName && (
                        <p className="text-[10px] text-slate-400 font-semibold mt-0.5">
                          Fournisseur : {anom.supplierName} • Montant : {formatEuro(anom.totalTtc)}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Monthly Recap Trigger */}
          <section className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 shadow-sm">
            <h2 className="text-xs font-black text-slate-900 tracking-wider uppercase border-b border-slate-100 pb-3 flex items-center gap-2">
              <svg className="w-4 h-4 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              ENVOI MANUEL RÉCAPITULATIF
            </h2>
            <p className="text-xs text-slate-500 font-medium">
              Génère le récapitulatif comptable en français et l&apos;envoie à l&apos;adresse de l&apos;comptable avec le journal CSV en pièce jointe.
            </p>

            <form onSubmit={handleTriggerRecap} className="flex flex-col gap-3 mt-1">
              <div>
                <label className="block text-[9px] uppercase font-bold text-slate-400 mb-1">Période (AAAA-MM)</label>
                <input
                  type="text"
                  placeholder="ex: 2026-06"
                  value={recapPeriod}
                  onChange={(e) => setRecapPeriod(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-red-600 focus:bg-white transition-all font-mono font-medium shadow-inner"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={recapLoading}
                className="w-full py-2.5 rounded-xl bg-red-600 text-white text-xs font-bold hover:bg-red-700 disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-md shadow-red-200 font-sans cursor-pointer"
              >
                {recapLoading ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Génération...
                  </>
                ) : (
                  "Déclencher l'envoi email"
                )}
              </button>
            </form>

            {recapSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs font-semibold mt-1">
                {recapSuccess}
              </div>
            )}
            {recapError && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-xl text-xs font-semibold mt-1">
                {recapError}
              </div>
            )}
          </section>
        </div>

        {/* Documents log table */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 shadow-sm">
          <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 border-b border-slate-100 pb-4">
            <h2 className="text-xs font-black text-slate-900 tracking-wider uppercase flex items-center gap-2">
              <svg className="w-4 h-4 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              JOURNAL DES PIÈCES COMPTABLES
            </h2>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                placeholder="Rechercher fournisseur..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-red-600 focus:bg-white transition-all w-full sm:w-56 font-medium shadow-inner"
              />

              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-red-600 focus:bg-white transition-all cursor-pointer font-bold shadow-inner"
              >
                <option value="all">Toutes catégories</option>
                <option value="supplier_invoice">Factures Fournisseurs</option>
                <option value="receipt">Tickets</option>
                <option value="quote">Devis</option>
                <option value="delivery_note">BL</option>
                <option value="other">Autres</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="py-20 flex flex-col items-center justify-center text-slate-400 text-xs font-semibold gap-3">
              <svg className="animate-spin h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Chargement du journal...
            </div>
          ) : filteredDocs.length === 0 ? (
            <div className="py-20 flex flex-col items-center justify-center text-slate-400 text-xs font-semibold">
              <svg className="w-10 h-10 text-slate-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0a2 2 0 01-2 2H6a2 2 0 01-2-2m16 0V9a2 2 0 00-2-2H6a2 2 0 00-2 2v4.5m16 3.5a2 2 0 01-2 2H6a2 2 0 01-2-2" />
              </svg>
              Aucun document enregistré.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[9px]">
                    <th className="pb-3 pr-2">Date Saisie</th>
                    <th className="pb-3 px-2">Canal</th>
                    <th className="pb-3 px-2">Type</th>
                    <th className="pb-3 px-2">Fournisseur</th>
                    <th className="pb-3 px-2">Date Doc</th>
                    <th className="pb-3 px-2 text-right">Montant TTC</th>
                    <th className="pb-3 px-2 text-center">Confiance</th>
                    <th className="pb-3 px-2">Statut</th>
                    <th className="pb-3 pl-2 text-right">Lien</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {filteredDocs.map((doc) => {
                    const parsedDate = new Date(doc.createdAt).toLocaleDateString("fr-FR", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    });

                    return (
                      <tr
                        key={doc.id}
                        className="hover:bg-slate-50/80 transition-colors text-slate-600 group"
                      >
                        <td className="py-3 pr-2 text-slate-400 font-mono">{parsedDate}</td>
                        <td className="py-3 px-2">
                          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                            {doc.channel === "whatsapp" ? (
                              <>
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                                WhatsApp
                              </>
                            ) : (
                              <>
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                                Gmail
                              </>
                            )}
                          </span>
                        </td>
                        <td className="py-3 px-2 text-slate-700">{getCategoryLabel(doc.docType)}</td>
                        <td className="py-3 px-2 font-bold text-slate-900">
                          {doc.supplierName || "-"}
                        </td>
                        <td className="py-3 px-2 font-mono text-[11px]">{formatDateFr(doc.docDate)}</td>
                        <td className="py-3 px-2 text-right font-bold text-slate-950">
                          {doc.docType === "delivery_note" ? "-" : formatEuro(doc.totalTtc)}
                        </td>
                        <td className="py-3 px-2 text-center">
                          {doc.minConfidence !== null ? (
                            <span
                              className={`font-mono font-bold text-[11px] ${
                                doc.minConfidence >= 0.9
                                  ? "text-emerald-600"
                                  : doc.minConfidence >= 0.75
                                  ? "text-blue-600"
                                  : "text-amber-600"
                              }`}
                            >
                              {Math.round(doc.minConfidence * 100)}%
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="py-3 px-2">{getStatusBadge(doc.status)}</td>
                        <td className="py-3 pl-2 text-right">
                          {doc.driveLink ? (
                            <a
                              href={doc.driveLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center p-1.5 rounded-lg bg-white border border-slate-200 text-red-600 hover:text-red-700 hover:border-red-300 hover:bg-red-50/20 transition-all shadow-sm"
                              title="Ouvrir dans Google Drive"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </a>
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-6 px-6 mt-12 shadow-inner">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-xs font-semibold text-slate-400">
          <div>© {new Date().getFullYear()} Klerk Operations Control. Tous droits réservés.</div>
          <div className="flex items-center gap-4">
            <span className="hover:text-red-600 transition-colors cursor-pointer">Documentation</span>
            <span>•</span>
            <span className="hover:text-red-600 transition-colors cursor-pointer">Support Technique</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
