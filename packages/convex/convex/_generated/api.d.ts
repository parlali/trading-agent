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
import type * as lib_instrumentClaims from "../lib/instrumentClaims.js";
import type * as lib_mutations_orders from "../lib/mutations/orders.js";
import type * as lib_mutations_portfolio from "../lib/mutations/portfolio.js";
import type * as lib_mutations_positions from "../lib/mutations/positions.js";
import type * as lib_mutations_strategies from "../lib/mutations/strategies.js";
import type * as lib_mutations_system from "../lib/mutations/system.js";
import type * as lib_queries_dashboard from "../lib/queries/dashboard.js";
import type * as lib_queries_orders from "../lib/queries/orders.js";
import type * as lib_queries_portfolio from "../lib/queries/portfolio.js";
import type * as lib_queries_positions from "../lib/queries/positions.js";
import type * as lib_queries_runs from "../lib/queries/runs.js";
import type * as lib_queries_strategies from "../lib/queries/strategies.js";
import type * as lib_queries_system from "../lib/queries/system.js";
import type * as lib_validators from "../lib/validators.js";
import type * as migrations_replaceStrategies from "../migrations/replaceStrategies.js";
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
  "lib/instrumentClaims": typeof lib_instrumentClaims;
  "lib/mutations/orders": typeof lib_mutations_orders;
  "lib/mutations/portfolio": typeof lib_mutations_portfolio;
  "lib/mutations/positions": typeof lib_mutations_positions;
  "lib/mutations/strategies": typeof lib_mutations_strategies;
  "lib/mutations/system": typeof lib_mutations_system;
  "lib/queries/dashboard": typeof lib_queries_dashboard;
  "lib/queries/orders": typeof lib_queries_orders;
  "lib/queries/portfolio": typeof lib_queries_portfolio;
  "lib/queries/positions": typeof lib_queries_positions;
  "lib/queries/runs": typeof lib_queries_runs;
  "lib/queries/strategies": typeof lib_queries_strategies;
  "lib/queries/system": typeof lib_queries_system;
  "lib/validators": typeof lib_validators;
  "migrations/replaceStrategies": typeof migrations_replaceStrategies;
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
