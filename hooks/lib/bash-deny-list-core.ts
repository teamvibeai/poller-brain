/**
 * Default bash deny-list — typo/accident protection, NOT adversarial
 * defense. See docs/bash-security-hardening.md and teamvibeai/teamvibe.ai#340
 * for the full threat model.
 *
 * This is deliberately a plain string/regex scan of the raw command text.
 * It is trivially bypassed by `bash -c`, variable indirection, base64|sh
 * decode-pipes, etc. — that is a known, accepted limitation (a floor, not
 * a ceiling), not a bug to fix here. The real enforcement boundary
 * (managed-settings.json + allowManagedHooksOnly, non-root execution) is
 * tracked separately as teamvibeai/teamvibe.ai#344.
 */

export interface DenyMatch {
  denied: boolean;
  ruleId?: string;
  reason?: string;
}

interface DenyRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

const RULES: DenyRule[] = [
  {
    id: "rm-rf-root",
    // rm with both -r and -f (any order, combined or separate flags, long
    // or short form) targeting `/` or `/*` as a standalone argument.
    pattern:
      /\brm\s+(?:(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)\s+)+\/\*?(?:\s|$)/,
    reason: "recursive force-delete of the root filesystem (rm -rf /)",
  },
  {
    id: "pipe-to-shell",
    // curl/wget piped (directly or via xargs) into a shell interpreter.
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
    reason: "piping a network download directly into a shell interpreter",
  },
  {
    id: "proc-mem-read",
    pattern: /\/proc\/(?:\d+|\$\$|self)\/mem\b/,
    reason: "reading process memory via /proc/*/mem",
  },
  {
    id: "ssh-key-read",
    // A read-oriented command whose arguments touch ~/.ssh (or a relative
    // or absolute .ssh/) — covers the common private-key exfil/typo shape
    // without trying to be a full shell parser. Char class must include
    // "/" (sibling to dotenv-read below) so absolute paths like
    // /root/.ssh/id_rsa match, not just ~/.ssh/... or bare .ssh/...
    pattern:
      /\b(?:cat|less|more|head|tail|strings|xxd|hexdump|od|base64)\b[^\n]*(?:~\/\.ssh\/|(?:^|[\s'"/])\.ssh\/)/,
    reason: "reading files under ~/.ssh/",
  },
  {
    id: "dotenv-read",
    pattern: /\b(?:cat|less|more|head|tail|strings|xxd|hexdump|od|base64)\b[^\n]*(?:^|[\s'"/])\.env\b/,
    reason: "reading a .env file",
  },
];

export function checkBashCommand(command: string): DenyMatch {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) {
      return { denied: true, ruleId: rule.id, reason: rule.reason };
    }
  }
  return { denied: false };
}
