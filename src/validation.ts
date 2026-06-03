import { PlatformUnsupportedError, ValidationError } from "./errors.js";
import { MAX_TYPED_CHARS, type ToolSpec } from "./types.js";

export function ensureMac(platform: NodeJS.Platform): void {
  if (platform !== "darwin") throw new PlatformUnsupportedError();
}

function validateKeySequenceStep(step: unknown, index: number): void {
  if (typeof step !== "object" || step === null)
    throw new ValidationError(`key_sequence: step ${index} must be an object`);

  const stepArgs = step as Record<string, unknown>;
  const unknownKey = Object.keys(stepArgs).find(
    (key) => key !== "key" && key !== "text",
  );
  if (unknownKey)
    throw new ValidationError(
      `key_sequence: step ${index} has unknown argument ${unknownKey}`,
    );

  const { key, text } = stepArgs;
  const hasKey = key !== undefined;
  const hasText = text !== undefined;
  if (hasKey === hasText)
    throw new ValidationError(
      `key_sequence: step ${index} must have exactly one of key or text`,
    );
  if (hasKey && typeof key !== "string")
    throw new ValidationError(
      `key_sequence: step ${index} key must be a string`,
    );
  if (hasText && typeof text !== "string")
    throw new ValidationError(
      `key_sequence: step ${index} text must be a string`,
    );
  if (hasText && text.length > MAX_TYPED_CHARS)
    throw new ValidationError(
      `key_sequence: step ${index} text too long (max ${MAX_TYPED_CHARS} chars)`,
    );
}

export function validateArgs(
  tool: ToolSpec,
  args: Record<string, unknown>,
): void {
  for (const field of tool.inputSchema.required ?? []) {
    if (
      args[field] === undefined ||
      args[field] === null ||
      args[field] === ""
    ) {
      throw new ValidationError(`${tool.name}: ${field} is required`, {
        field,
      });
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const prop = tool.inputSchema.properties[key];
    if (!prop)
      throw new ValidationError(`${tool.name}: unknown argument ${key}`, {
        field: key,
      });
    if (prop.type === "string" && typeof value !== "string")
      throw new ValidationError(`${tool.name}: ${key} must be a string`);
    if (
      prop.type === "number" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new ValidationError(`${tool.name}: ${key} must be a finite number`);
    }
    if (prop.type === "boolean" && typeof value !== "boolean")
      throw new ValidationError(`${tool.name}: ${key} must be a boolean`);
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
      throw new ValidationError(
        `${tool.name}: ${key} must be one of ${prop.enum.join(", ")}`,
      );
    }
  }
  if (tool.name === "click") {
    const hasIndex = args.element_index !== undefined;
    const hasCoords = args.x !== undefined || args.y !== undefined;
    if (!hasIndex && !hasCoords)
      throw new ValidationError(
        "click requires element_index or x/y coordinates",
      );
    if (hasIndex && hasCoords)
      throw new ValidationError(
        "click accepts element_index or x/y coordinates, not both",
      );
    if (hasCoords && (args.x === undefined || args.y === undefined))
      throw new ValidationError("click coordinates require both x and y");
  }
  if (
    tool.name === "type_text" &&
    typeof args.text === "string" &&
    args.text.length > MAX_TYPED_CHARS
  ) {
    throw new ValidationError(
      `type_text: text too long (${args.text.length} chars; max ${MAX_TYPED_CHARS})`,
    );
  }
  if (tool.name === "key_sequence") {
    const { steps } = args;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new ValidationError(
        "key_sequence: steps must be a non-empty array",
      );
    }
    steps.forEach(validateKeySequenceStep);
  }
}
