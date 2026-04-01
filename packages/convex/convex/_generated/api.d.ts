/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as auth from "../auth.js";
import type * as connectionTests from "../connectionTests.js";
import type * as http from "../http.js";
import type * as lib_authGuards from "../lib/authGuards.js";
import type * as migrations_simplifyPolicy from "../migrations/simplifyPolicy.js";
import type * as mutations from "../mutations.js";
import type * as queries from "../queries.js";
import type * as seedUserAction from "../seedUserAction.js";
import type * as seedUserHelpers from "../seedUserHelpers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actions: typeof actions;
  auth: typeof auth;
  connectionTests: typeof connectionTests;
  http: typeof http;
  "lib/authGuards": typeof lib_authGuards;
  "migrations/simplifyPolicy": typeof migrations_simplifyPolicy;
  mutations: typeof mutations;
  queries: typeof queries;
  seedUserAction: typeof seedUserAction;
  seedUserHelpers: typeof seedUserHelpers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
