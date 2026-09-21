// Model id -> human-readable label, for display only (e.g. the project list's
// "transcribed with" badge). Keep in sync with the model dropdowns
// (Transcribe.jsx, TranscribeAllDialog.jsx, Sidebar.jsx, ProjectList.jsx).
export const MODEL_LABELS = {
  "Tridis_Medieval_EarlyModern.mlmodel": "Tridis Medieval EarlyModern",
  "cremma-generic-1.0.1.mlmodel": "Cremma Generic 1.0.1",
  "ManuMcFondue.mlmodel": "ManuMcFondue",
  "catmus-medieval.mlmodel": "Catmus Medieval",
  "catmus-print-fondue-large.mlmodel": "CATMUS Print Model",
  "McCATMuS_nfd_nofix_V1.mlmodel": "McCATMuS (16th-21st c. Polyglot)",
  "lectaurep_base.mlmodel": "LECTAUREP (French Admin)",
  "peraire2_ft_MMCFR.mlmodel": "Lucien Peraire (French Handwriting)",
  "german_handwriting.mlmodel": "German Handwriting",
  "en_best.mlmodel": "Modern English Print",
  "TrOCR_Manicule_2026_Latin_Medieval": "TrOCR Manicule (Latin Medieval HTR)",
};

export const modelLabel = (modelName) => MODEL_LABELS[modelName] || modelName;
