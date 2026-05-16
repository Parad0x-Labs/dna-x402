import { describe, expect, it } from "vitest";
import { AgentBuilderRepositories, AgentBuilderService } from "../../src/agents/builder/compiler.js";
import { createPostgresCommerceRepositories } from "../../src/db/repositories.js";
import { createLivePostgres, postgresAvailable, resetAndMigrateLivePostgres, withLivePostgresTestLock } from "./postgres-test-helpers.js";

function builderRepos(repos: ReturnType<typeof createPostgresCommerceRepositories>): AgentBuilderRepositories {
  return {
    drafts: repos.agent_builder_drafts as AgentBuilderRepositories["drafts"],
    recipes: repos.agent_recipes as AgentBuilderRepositories["recipes"],
    events: repos.agent_builder_events as AgentBuilderRepositories["events"],
  };
}

const safePrompt = [
  "Create a Polymarket copy agent that follows BTC 5m markets,",
  "only copies entries between 40c and 60c, max $5 per bet,",
  "stops after $25 daily loss, max open exposure $100,",
  "copies buys only, and charges followers 2% of profit.",
].join(" ");

describe.skipIf(!postgresAvailable)("live Postgres agent builder durability", () => {
  it("persists drafts, confirmations, recipes, clones, and events across restart", async () => {
    await withLivePostgresTestLock(async () => {
      const db = createLivePostgres();
      try {
        await resetAndMigrateLivePostgres(db);
        const repos = createPostgresCommerceRepositories(db);
        const first = new AgentBuilderService(() => new Date("2026-05-16T12:00:00.000Z"), builderRepos(repos));
        const draft = await first.createDraft({
          inputMode: "PROMPT",
          prompt: safePrompt,
          ownerWallet: "owner-wallet-live",
        });
        expect(draft.status).toBe("DRAFT_CREATED");
        expect(draft.agentConfig?.copySettings?.minEntryPriceBps).toBe(4000);
        expect(draft.agentConfig?.backendCustody).toBe(false);
        expect(draft.agentConfig?.backendSigning).toBe(false);

        const rejected = await first.createDraft({
          inputMode: "PROMPT",
          prompt: "Create an agent that stores my private key on the server.",
          ownerWallet: "owner-wallet-live",
        });
        expect(rejected.status).toBe("REJECTED");
        expect(rejected.reasonCodes).toContain("AGENT_BUILDER_PRIVATE_KEY_FORBIDDEN");
      } finally {
        await db.close();
      }

      const restartedDb = createLivePostgres();
      try {
        const repos = createPostgresCommerceRepositories(restartedDb);
        const restarted = new AgentBuilderService(() => new Date("2026-05-16T12:01:00.000Z"), builderRepos(repos));
        const rows = await repos.agent_builder_drafts.list();
        const promptDraft = rows.find((row) => row.payload.result.agentConfig?.ownerWallet === "owner-wallet-live" && row.payload.status === "DRAFT");
        expect(promptDraft).toBeTruthy();
        const risk = promptDraft!.payload.result.riskSummary!;
        const confirmed = await restarted.confirmDraft({
          draftId: promptDraft!.payload.draftId,
          ownerWallet: "owner-wallet-live",
          acceptedRiskSummary: true,
          confirmations: risk.requiredConfirmations,
        });
        expect(confirmed.draft.status).toBe("CONFIRMED");

        const recipe = await restarted.createRecipe({
          ownerWallet: "owner-wallet-live",
          title: "Live Durable BTC Copy",
          description: "Cloneable durable builder recipe.",
          config: confirmed.agentConfig,
          riskSummary: confirmed.riskSummary,
          visibility: "CLONEABLE",
          source: "PROMPT",
        });
        expect(recipe.visibility).toBe("CLONEABLE");

      } finally {
        await restartedDb.close();
      }

      const finalDb = createLivePostgres();
      try {
        const repos = createPostgresCommerceRepositories(finalDb);
        const final = new AgentBuilderService(() => new Date("2026-05-16T12:02:00.000Z"), builderRepos(repos));
        const publicRecipes = await final.publicRecipes();
        const recipe = publicRecipes.find((item) => item.title === "Live Durable BTC Copy");
        expect(recipe).toBeTruthy();
        const cloned = await final.cloneRecipe(recipe!.recipeId, "clone-owner-wallet-live");
        expect(cloned.status).toBe("DRAFT_CREATED");
        expect(cloned.agentConfig?.ownerWallet).toBe("clone-owner-wallet-live");
        const events = await final.listEvents();
        expect(events.some((event) => event.kind === "AGENT_BUILDER_DRAFT_CONFIRMED")).toBe(true);
        expect(events.some((event) => event.kind === "AGENT_RECIPE_CREATED")).toBe(true);
        expect(events.some((event) => event.reasonCodes?.includes("AGENT_BUILDER_PRIVATE_KEY_FORBIDDEN"))).toBe(true);
      } finally {
        await finalDb.close();
      }
    });
  }, 60_000);
});
