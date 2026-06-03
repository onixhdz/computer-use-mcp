export class ComputerUseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = code;
  }
}

export class PlatformUnsupportedError extends ComputerUseError {
  constructor() {
    super("platform_unsupported", "computer-use currently supports macOS only");
  }
}
export class ValidationError extends ComputerUseError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("validation_error", message, details);
  }
}
export class AppNotFoundError extends ComputerUseError {
  constructor(app: string) {
    super("app_not_found", `app not found or not running: ${app}`, { app });
  }
}
export class BackendError extends ComputerUseError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("backend_error", message, details);
  }
}
