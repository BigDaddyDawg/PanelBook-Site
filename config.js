/* PanelBook scanner config.
   Anon key is safe to expose: RLS allows read of owned_comics + insert to scan inbox.
   Writes to the live master go through the commit-owned Edge Function, gated by PIN. */
window.PANELBOOK_CONFIG = {
  SUPABASE_URL: "https://oaonarmpqybbvtldlusx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_OrFwBgK_07qSvS6myJNHGA_84D6Z-Oj",
  SCANS_TABLE: "panelbook_scans",
  OWNED_TABLE: "owned_comics",
  COMMIT_FUNCTION: "commit-owned",
  /* Family PIN — default matches DB seed. Change both together if you rotate. */
  DEFAULT_COMMIT_PIN: "panelbook",
};
