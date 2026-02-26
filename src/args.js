export function hasFlag(providerArgs, longName, shortName = null) {
  for (let index = 0; index < providerArgs.length; index += 1) {
    const value = String(providerArgs[index] || '');
    if (value === longName || value.startsWith(`${longName}=`)) {
      return true;
    }
    if (shortName && value === shortName) {
      return true;
    }
  }
  return false;
}

export function applyDefaultBypassArgs(provider, providerArgs) {
  const args = Array.isArray(providerArgs) ? [...providerArgs] : [];

  if (provider === 'claude') {
    const hasExplicitPermissionMode =
      hasFlag(args, '--permission-mode') || hasFlag(args, '--dangerously-skip-permissions') || hasFlag(args, '--allow-dangerously-skip-permissions');

    if (!hasExplicitPermissionMode) {
      args.unshift('--dangerously-skip-permissions');
      return { providerArgs: args, defaultBypassApplied: true };
    }

    return { providerArgs: args, defaultBypassApplied: false };
  }

  if (provider === 'codex') {
    const hasExplicitPermissionMode =
      hasFlag(args, '--dangerously-bypass-approvals-and-sandbox') ||
      hasFlag(args, '--full-auto') ||
      hasFlag(args, '--sandbox', '-s') ||
      hasFlag(args, '--ask-for-approval', '-a');

    if (!hasExplicitPermissionMode) {
      args.unshift('--dangerously-bypass-approvals-and-sandbox');
      return { providerArgs: args, defaultBypassApplied: true };
    }

    return { providerArgs: args, defaultBypassApplied: false };
  }

  return { providerArgs: args, defaultBypassApplied: false };
}
