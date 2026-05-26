/**
 * Layer: Note ledger data contract
 *
 * TypeScript mirror of the `dark-note-ledger` Rust crate format.
 * Tests note tracking, spend tracking, double-entry rejection,
 * count invariants, and JSON serialisation rules (no raw note values
 * as separate top-level fields).
 *
 * No source imports needed. NoteLedger is implemented inline below.
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation — mirrors dark-note-ledger Rust crate
// ---------------------------------------------------------------------------

interface NoteEntry {
  commitment: string; // hex-encoded note commitment (unique identifier)
  value: bigint;      // note value in atomic units
  spent: boolean;
}

interface LedgerSummaryJson {
  entry_count: number;
  unspent_count: number;
  total_unspent: string; // stringified bigint to avoid JS precision issues
}

class NoteLedger {
  private entries: Map<string, NoteEntry> = new Map();

  get totalUnspent(): bigint {
    let sum = 0n;
    for (const e of this.entries.values()) {
      if (!e.spent) sum += e.value;
    }
    return sum;
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get spentCount(): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.spent) n++;
    }
    return n;
  }

  get unspentCount(): number {
    return this.entryCount - this.spentCount;
  }

  get unspentNotes(): NoteEntry[] {
    return [...this.entries.values()].filter((e) => !e.spent);
  }

  trackNote(commitment: string, value: bigint): void {
    if (this.entries.has(commitment)) {
      throw new Error(`commitment already tracked: ${commitment}`);
    }
    this.entries.set(commitment, { commitment, value, spent: false });
  }

  markSpent(commitment: string): void {
    const entry = this.entries.get(commitment);
    if (!entry) throw new Error(`unknown commitment: ${commitment}`);
    if (entry.spent) throw new Error(`already spent: ${commitment}`);
    entry.spent = true;
  }

  summaryJson(): LedgerSummaryJson {
    return {
      entry_count: this.entryCount,
      unspent_count: this.unspentCount,
      total_unspent: this.totalUnspent.toString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dark-null note ledger data contract", () => {
  it("new ledger has total_unspent = 0 and empty entries", () => {
    const ledger = new NoteLedger();
    expect(ledger.totalUnspent).toBe(0n);
    expect(ledger.entryCount).toBe(0);
    expect(ledger.unspentNotes).toHaveLength(0);
  });

  it("tracking a note increments total_unspent by note.value", () => {
    const ledger = new NoteLedger();
    ledger.trackNote("commit-aaa", 1_000_000n);
    expect(ledger.totalUnspent).toBe(1_000_000n);

    ledger.trackNote("commit-bbb", 500_000n);
    expect(ledger.totalUnspent).toBe(1_500_000n);
  });

  it("marking a note spent decrements total_unspent", () => {
    const ledger = new NoteLedger();
    ledger.trackNote("commit-ccc", 2_000_000n);
    ledger.trackNote("commit-ddd", 800_000n);
    expect(ledger.totalUnspent).toBe(2_800_000n);

    ledger.markSpent("commit-ccc");
    expect(ledger.totalUnspent).toBe(800_000n);
  });

  it("tracking the same commitment twice is rejected", () => {
    const ledger = new NoteLedger();
    ledger.trackNote("commit-dup", 100n);
    expect(() => ledger.trackNote("commit-dup", 200n)).toThrow(/already tracked/);
    // Ledger state must be unchanged
    expect(ledger.totalUnspent).toBe(100n);
  });

  it("unspent_count = entry_count − spent_count", () => {
    const ledger = new NoteLedger();
    ledger.trackNote("n1", 100n);
    ledger.trackNote("n2", 200n);
    ledger.trackNote("n3", 300n);
    ledger.markSpent("n2");

    expect(ledger.entryCount).toBe(3);
    expect(ledger.spentCount).toBe(1);
    expect(ledger.unspentCount).toBe(ledger.entryCount - ledger.spentCount);
    expect(ledger.unspentCount).toBe(2);
  });

  it("ledger_summary_json contains entry_count, unspent_count, total_unspent but not individual note values as raw numbers", () => {
    const ledger = new NoteLedger();
    const note1Value = 777_000n;
    const note2Value = 333_000n;
    ledger.trackNote("n-a", note1Value);
    ledger.trackNote("n-b", note2Value);

    const summary = ledger.summaryJson();
    const json = JSON.stringify(summary);

    // Required top-level fields
    expect(json).toContain("entry_count");
    expect(json).toContain("unspent_count");
    expect(json).toContain("total_unspent");

    // total_unspent should be the aggregate, as a string
    const parsed = JSON.parse(json) as LedgerSummaryJson;
    expect(parsed.total_unspent).toBe((note1Value + note2Value).toString());

    // Individual note values must NOT appear as separate numeric fields
    // (summaryJson only returns aggregate metadata)
    expect(json).not.toContain(note1Value.toString());
    expect(json).not.toContain(note2Value.toString());
  });
});
