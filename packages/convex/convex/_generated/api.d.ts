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
import type * as lib_cascadeDelete from "../lib/cascadeDelete.js";
import type * as lib_controlPlaneMetrics from "../lib/controlPlaneMetrics.js";
import type * as lib_dryRunLedger from "../lib/dryRunLedger.js";
import type * as lib_heartbeatModel from "../lib/heartbeatModel.js";
import type * as lib_instrumentClaims from "../lib/instrumentClaims.js";
import type * as lib_killSwitchState from "../lib/killSwitchState.js";
import type * as lib_mutations_orders from "../lib/mutations/orders.js";
import type * as lib_mutations_portfolio from "../lib/mutations/portfolio.js";
import type * as lib_mutations_portfolioGovernance from "../lib/mutations/portfolioGovernance.js";
import type * as lib_mutations_portfolioOrderClosureReconciliation from "../lib/mutations/portfolioOrderClosureReconciliation.js";
import type * as lib_mutations_portfolioOrderInference from "../lib/mutations/portfolioOrderInference.js";
import type * as lib_mutations_portfolioOrderRuns from "../lib/mutations/portfolioOrderRuns.js";
import type * as lib_mutations_portfolioOrders from "../lib/mutations/portfolioOrders.js";
import type * as lib_mutations_portfolioOwnership from "../lib/mutations/portfolioOwnership.js";
import type * as lib_mutations_portfolioRows from "../lib/mutations/portfolioRows.js";
import type * as lib_mutations_portfolioSnapshots from "../lib/mutations/portfolioSnapshots.js";
import type * as lib_mutations_portfolioTestables from "../lib/mutations/portfolioTestables.js";
import type * as lib_mutations_portfolioTypes from "../lib/mutations/portfolioTypes.js";
import type * as lib_mutations_portfolioUtils from "../lib/mutations/portfolioUtils.js";
import type * as lib_mutations_portfolioWorkingOrders from "../lib/mutations/portfolioWorkingOrders.js";
import type * as lib_mutations_positions from "../lib/mutations/positions.js";
import type * as lib_mutations_risk from "../lib/mutations/risk.js";
import type * as lib_mutations_strategies from "../lib/mutations/strategies.js";
import type * as lib_mutations_strategyCascadeDelete from "../lib/mutations/strategyCascadeDelete.js";
import type * as lib_mutations_system from "../lib/mutations/system.js";
import type * as lib_mutations_systemHeartbeats from "../lib/mutations/systemHeartbeats.js";
import type * as lib_mutations_systemManualRuns from "../lib/mutations/systemManualRuns.js";
import type * as lib_mutations_systemReset from "../lib/mutations/systemReset.js";
import type * as lib_orderIdentityLookup from "../lib/orderIdentityLookup.js";
import type * as lib_providerPositions from "../lib/providerPositions.js";
import type * as lib_queries_dashboard from "../lib/queries/dashboard.js";
import type * as lib_queries_orders from "../lib/queries/orders.js";
import type * as lib_queries_portfolio from "../lib/queries/portfolio.js";
import type * as lib_queries_positions from "../lib/queries/positions.js";
import type * as lib_queries_risk from "../lib/queries/risk.js";
import type * as lib_queries_runs from "../lib/queries/runs.js";
import type * as lib_queries_strategies from "../lib/queries/strategies.js";
import type * as lib_queries_system from "../lib/queries/system.js";
import type * as lib_validators from "../lib/validators.js";
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
  "lib/cascadeDelete": typeof lib_cascadeDelete;
  "lib/controlPlaneMetrics": typeof lib_controlPlaneMetrics;
  "lib/dryRunLedger": typeof lib_dryRunLedger;
  "lib/heartbeatModel": typeof lib_heartbeatModel;
  "lib/instrumentClaims": typeof lib_instrumentClaims;
  "lib/killSwitchState": typeof lib_killSwitchState;
  "lib/mutations/orders": typeof lib_mutations_orders;
  "lib/mutations/portfolio": typeof lib_mutations_portfolio;
  "lib/mutations/portfolioGovernance": typeof lib_mutations_portfolioGovernance;
  "lib/mutations/portfolioOrderClosureReconciliation": typeof lib_mutations_portfolioOrderClosureReconciliation;
  "lib/mutations/portfolioOrderInference": typeof lib_mutations_portfolioOrderInference;
  "lib/mutations/portfolioOrderRuns": typeof lib_mutations_portfolioOrderRuns;
  "lib/mutations/portfolioOrders": typeof lib_mutations_portfolioOrders;
  "lib/mutations/portfolioOwnership": typeof lib_mutations_portfolioOwnership;
  "lib/mutations/portfolioRows": typeof lib_mutations_portfolioRows;
  "lib/mutations/portfolioSnapshots": typeof lib_mutations_portfolioSnapshots;
  "lib/mutations/portfolioTestables": typeof lib_mutations_portfolioTestables;
  "lib/mutations/portfolioTypes": typeof lib_mutations_portfolioTypes;
  "lib/mutations/portfolioUtils": typeof lib_mutations_portfolioUtils;
  "lib/mutations/portfolioWorkingOrders": typeof lib_mutations_portfolioWorkingOrders;
  "lib/mutations/positions": typeof lib_mutations_positions;
  "lib/mutations/risk": typeof lib_mutations_risk;
  "lib/mutations/strategies": typeof lib_mutations_strategies;
  "lib/mutations/strategyCascadeDelete": typeof lib_mutations_strategyCascadeDelete;
  "lib/mutations/system": typeof lib_mutations_system;
  "lib/mutations/systemHeartbeats": typeof lib_mutations_systemHeartbeats;
  "lib/mutations/systemManualRuns": typeof lib_mutations_systemManualRuns;
  "lib/mutations/systemReset": typeof lib_mutations_systemReset;
  "lib/orderIdentityLookup": typeof lib_orderIdentityLookup;
  "lib/providerPositions": typeof lib_providerPositions;
  "lib/queries/dashboard": typeof lib_queries_dashboard;
  "lib/queries/orders": typeof lib_queries_orders;
  "lib/queries/portfolio": typeof lib_queries_portfolio;
  "lib/queries/positions": typeof lib_queries_positions;
  "lib/queries/risk": typeof lib_queries_risk;
  "lib/queries/runs": typeof lib_queries_runs;
  "lib/queries/strategies": typeof lib_queries_strategies;
  "lib/queries/system": typeof lib_queries_system;
  "lib/validators": typeof lib_validators;
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
