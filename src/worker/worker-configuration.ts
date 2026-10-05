export class WorkerConfiguration {
  constructor(private readonly appendSystemPrompt?: string) {}

  buildThreadParams(cwd: string, readOnly = false): Record<string, unknown> {
    return {
      cwd,
      approvalPolicy: "never",
      sandbox: readOnly ? "read-only" : "danger-full-access",
      config: { web_search: "live" },
      ...(this.appendSystemPrompt
        ? { developerInstructions: this.appendSystemPrompt }
        : {}),
    };
  }
}
