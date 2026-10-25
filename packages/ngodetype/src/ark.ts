/**
 * ArkType compatibility facade — `@ngodeai/ngodetype/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the ngodetype lazy-JIT runtime: swap `from "arktype"` for
 * `from "@ngodeai/ngodetype/ark"` and nothing else changes. New code should
 * import `@ngodeai/ngodetype` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `OmpError` /
 * `OmpErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { OmpError, OmpErrors } from "./errors";

export * from "./index";

export const ArkError = OmpError;
export type ArkError = OmpError;
export const ArkErrors = OmpErrors;
export type ArkErrors = OmpErrors;
