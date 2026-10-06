# Context Capsule — Public Proof (moved)

This page described the `bench-public.ts` run on the 109-message fixture
(savings 99.3%, recovery 36/40). On 2026-10-06 the method and results moved to
[CONTEXT_CAPSULE_BENCHMARK.md](CONTEXT_CAPSULE_BENCHMARK.md), which also:

- states that the 99.3% figure is the initial pointer string only and excludes retrieved text;
- corrects the recovery score to 34/40 (two questions had passed because the search header repeats the question);
- reports archive size, retrieval token cost, and sliding-window / top-k retrieval baselines;
- defines the end-to-end model-task comparison, which has not been run yet.

How the data moves through the package: [CONTEXT_CAPSULE_DATAFLOW.md](CONTEXT_CAPSULE_DATAFLOW.md).
