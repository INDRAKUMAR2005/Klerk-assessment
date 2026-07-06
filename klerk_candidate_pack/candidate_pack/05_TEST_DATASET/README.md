# Test Dataset — Klerk Mission

This folder contains the official test corpus. **Your final demo and your eval script must run against these files** — you may create additional documents of your own for development, but grading uses this corpus (plus a private extension of the same style).

All companies, SIREN/SIRET numbers, IBANs, people and amounts are **fictitious**. Documents are in French on purpose (see Mission Pack §1.6).

## Contents

### `whatsapp_inbox/` — 12 items → send these on WhatsApp

Send each file from your second phone ("Julien") to the WhatsApp number connected to Unipile. Spread them over your test window in any realistic order — real artisans don't batch-upload. Photos are photos (send as images); PDFs are documents (send as files).

| File | What Julien would say it is |
|---|---|
| `photo_facture_sanitherm.jpg` | photo of a supplier invoice, taken on a job site |
| `photo_facture_negoce_bati_sud.jpg` | photo of a supplier invoice |
| `photo_ticket_carburant.jpg` | photo of a fuel receipt |
| `photo_ticket_bricoexpress.jpg` | photo of a hardware-store receipt |
| `facture_plombipro_F2026-0433.pdf` | supplier invoice (PDF forwarded on WhatsApp) |
| `facture_plombipro_F2026-0781.pdf` | supplier invoice |
| `facture_elecstock_EL-26-2210.pdf` | supplier invoice |
| `facture_locabenne_LB-2026-0640.pdf` | supplier invoice |
| `facture_quincaillerie_bertrand_QB-1194.pdf` | supplier invoice |
| `facture_carrelages_forez_CF-2026-388.pdf` | supplier invoice |
| `devis_signe_martin_DEV-2026-041_scan.pdf` | a quote Julien issued to a client, signed, scanned |
| `bl_sanitherm_BL-7734.pdf` | a delivery note |

### `email_inbox/` — 3 items → inject these into the test Gmail inbox

Standard `.eml` files (RFC 822, attachments included). Inject them into the dedicated test Gmail account, either via the Gmail API (`users.messages.import` keeps original headers) or by re-sending the extracted attachments from another mailbox with a similar subject/body. Document your method in the README.

| File | Subject |
|---|---|
| `email_01_sanitherm_facture.eml` | Votre facture INV-2026-0612 |
| `email_02_rhone_3pj.eml` | Facture FA-26-05-1187 + documents |
| `email_03_promo_energie.eml` | Réduisez vos factures d'énergie — offre spéciale artisans |

### `eval_questions_public.json`

8 reference Q&A pairs (French questions, expected answers/behaviors) covering the three router paths. Your eval script must run these end-to-end **after the full corpus has been ingested** and print a pass/fail report. A private set of the same style is used during grading — build for the pattern, not for the 8 strings.

## Notes

- The corpus is intentionally heterogeneous: clean PDFs, phone photos of varying quality, thermal receipts, a scanned signed quote, a delivery note, and emails whose attachments are not all financial documents. Handle each item the way the spec says a real system should — including the cases where the correct behavior is to ask, to ignore, or to flag.
- Do not "fix" the source files (no manual cropping, rotating, or retyping). The system must cope with them as-is.
