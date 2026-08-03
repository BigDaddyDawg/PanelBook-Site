/* PanelBook scanner config.
   Fill these in to enable the "Push to master" button (sync scans to Supabase).
   The anon/public key is safe to expose in a static site: it only allows the
   inserts permitted by your Row Level Security policy. Leave blank to keep the
   scanner local-only (Export CSV still works). */
window.PANELBOOK_CONFIG = {
  SUPABASE_URL: "https://oaonarmpqybbvtldlusx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_OrFwBgK_07qSvS6myJNHGA_84D6Z-Oj",
  SCANS_TABLE: "panelbook_scans",
};
