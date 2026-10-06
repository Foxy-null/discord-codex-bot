export class WorkerConfiguration {
  constructor(private readonly appendSystemPrompt?: string) {}

  buildThreadParams(cwd: string): Record<string, unknown> {
    return {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: { web_search: "live" },
      ...(this.appendSystemPrompt
        ? { developerInstructions: this.appendSystemPrompt }
        : {}),
    };
  }
}
