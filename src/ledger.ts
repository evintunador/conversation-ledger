import { fileURLToPath } from "node:url";
import { openLedger, type Ledger, type NamespaceConfig, type RepoInfo } from "annals";

/**
 * cledger's annals namespace. The names predate the extraction and are kept:
 * records live at refs/notes/conversation-ledger, local state under
 * .git/conversation-ledger/, config in .cledger.json and ~/.config/cledger/,
 * and the pre-push hook invokes this package's own CLI.
 */
export const CLEDGER_NAMESPACE: NamespaceConfig = {
  name: "conversation-ledger",
  incomingName: "cledger-incoming",
  stateDirName: "conversation-ledger",
  configFile: ".cledger.json",
  userConfigDir: "cledger",
  cliName: "cledger",
  hookInvocation: {
    node: process.execPath,
    cli: fileURLToPath(new URL("./cli.js", import.meta.url)),
  },
};

/** Bind a plain repo handle to cledger's namespace. Pure and cheap. */
export function asLedger(repo: RepoInfo): Ledger {
  return openLedger(repo, CLEDGER_NAMESPACE);
}
