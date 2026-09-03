/**
 * The one canonical place this app's bundled router plugin's package name is
 * declared. Everything that needs to compare against or default to this
 * plugin's identity (the Preferences dropdown's pre-migration default, the
 * Auto entry's fallback identity, the main-process demo-env override table)
 * imports this constant instead of re-declaring its own local copy of the
 * same string -- keeps every reader in sync if the bundled plugin's package
 * name ever changes. Lives under `shared/` (not `renderer/`) so both the
 * main process and the renderer can import it.
 */
export const LEVANTO_ROUTER_PACKAGE = '@antseed/router-levanto';
