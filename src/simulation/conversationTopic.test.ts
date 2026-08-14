import { describe, expect, it } from "vitest";
import {
  computeClusterTopicFatigue,
  createInitialClusterTopicState,
  MAX_RECENT_SPEAKERS_PER_CLUSTER,
  MAX_RECENT_TOPICS_PER_CLUSTER,
  pruneClusterTopicRuntimeState,
  recordSkip,
  recordUtterance,
  syncClusterMembership,
  type ClusterTopicRuntimeState,
} from "./conversationTopic";

/**
 * Issue #230 (Phase 5): cluster単位の会話topic runtime state(`ClusterTopicState`)を検証する。
 * 話者・topic・claim選択の重み付けロジックは`contentUtterance.test.ts`側が扱う。
 */

describe("createInitialClusterTopicState", () => {
  it("starts with no current topic and empty rolling windows", () => {
    const state = createInitialClusterTopicState("group-1");
    expect(state.clusterId).toBe("group-1");
    expect(state.currentTopicId).toBeUndefined();
    expect(state.topicStartedTick).toBeUndefined();
    expect(state.lastUtteranceTick).toBeUndefined();
    expect(state.recentTopicIds).toEqual([]);
    expect(state.recentSpeakerIds).toEqual([]);
    expect(state.repetitionCount).toBe(0);
  });
});

describe("recordUtterance", () => {
  it("starts a new topic on the first utterance", () => {
    const state = createInitialClusterTopicState("group-1");
    const next = recordUtterance(state, { topicId: "topic:a", speakerId: "agent-1", claimId: "claim:a", tick: 5 });
    expect(next.currentTopicId).toBe("topic:a");
    expect(next.topicStartedTick).toBe(5);
    expect(next.lastUtteranceTick).toBe(5);
    expect(next.repetitionCount).toBe(1);
    expect(next.recentTopicIds).toEqual(["topic:a"]);
    expect(next.recentSpeakerIds).toEqual(["agent-1"]);
    expect(next.speakerLastTurnTick).toEqual({ "agent-1": 5 });
    expect(next.claimLastToldTick).toEqual({ "claim:a": 5 });
  });

  it("increments repetitionCount when the same topic continues", () => {
    let state = createInitialClusterTopicState("group-1");
    state = recordUtterance(state, { topicId: "topic:a", speakerId: "agent-1", claimId: "claim:a", tick: 1 });
    state = recordUtterance(state, { topicId: "topic:a", speakerId: "agent-2", claimId: "claim:b", tick: 5 });
    expect(state.repetitionCount).toBe(2);
    expect(state.topicStartedTick).toBe(1); // 継続中はtopicStartedTickが変わらない
    expect(state.lastUtteranceTick).toBe(5);
  });

  it("resets repetitionCount and topicStartedTick when the topic changes", () => {
    let state = createInitialClusterTopicState("group-1");
    state = recordUtterance(state, { topicId: "topic:a", speakerId: "agent-1", claimId: "claim:a", tick: 1 });
    state = recordUtterance(state, { topicId: "topic:b", speakerId: "agent-2", claimId: "claim:c", tick: 4 });
    expect(state.currentTopicId).toBe("topic:b");
    expect(state.topicStartedTick).toBe(4);
    expect(state.repetitionCount).toBe(1);
  });

  it("caps recentTopicIds/recentSpeakerIds at the configured window, oldest-first", () => {
    let state = createInitialClusterTopicState("group-1");
    const overflow = MAX_RECENT_TOPICS_PER_CLUSTER + 3;
    for (let i = 0; i < overflow; i++) {
      state = recordUtterance(state, { topicId: `topic:${i}`, speakerId: `agent-${i}`, claimId: `claim:${i}`, tick: i });
    }
    expect(state.recentTopicIds).toHaveLength(MAX_RECENT_TOPICS_PER_CLUSTER);
    expect(state.recentSpeakerIds).toHaveLength(MAX_RECENT_SPEAKERS_PER_CLUSTER);
    // 最も古いものが押し出され、直近のものが末尾に残る
    expect(state.recentTopicIds[state.recentTopicIds.length - 1]).toBe(`topic:${overflow - 1}`);
    expect(state.recentTopicIds[0]).toBe(`topic:${overflow - MAX_RECENT_TOPICS_PER_CLUSTER}`);
  });

  it("clears lastSkipReason on a successful utterance", () => {
    let state = createInitialClusterTopicState("group-1");
    state = recordSkip(state, "noEligibleSpeaker").state;
    expect(state.lastSkipReason).toBe("noEligibleSpeaker");
    state = recordUtterance(state, { topicId: "topic:a", speakerId: "agent-1", claimId: "claim:a", tick: 1 });
    expect(state.lastSkipReason).toBeUndefined();
  });
});

describe("recordSkip", () => {
  it("reports shouldLog=true only the first time a given reason is recorded", () => {
    let state = createInitialClusterTopicState("group-1");
    const first = recordSkip(state, "noEligibleClaim");
    expect(first.shouldLog).toBe(true);
    state = first.state;

    const second = recordSkip(state, "noEligibleClaim");
    expect(second.shouldLog).toBe(false);
    state = second.state;

    const third = recordSkip(state, "noEligibleSpeaker");
    expect(third.shouldLog).toBe(true);
  });
});

describe("syncClusterMembership", () => {
  it("detects a newly joined member not previously known", () => {
    const state = createInitialClusterTopicState("group-1");
    const first = syncClusterMembership(state, ["agent-1", "agent-2"]);
    expect(first.hasNewMember).toBe(true);
    expect(first.state.knownMemberIds).toEqual(["agent-1", "agent-2"]);

    const second = syncClusterMembership(first.state, ["agent-1", "agent-2"]);
    expect(second.hasNewMember).toBe(false);

    const third = syncClusterMembership(second.state, ["agent-1", "agent-2", "agent-3"]);
    expect(third.hasNewMember).toBe(true);
    expect(third.state.knownMemberIds).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  it("does not report a new member when someone merely leaves", () => {
    const state = createInitialClusterTopicState("group-1");
    const withThree = syncClusterMembership(state, ["agent-1", "agent-2", "agent-3"]).state;
    const afterLeave = syncClusterMembership(withThree, ["agent-1", "agent-2"]);
    expect(afterLeave.hasNewMember).toBe(false);
  });
});

describe("computeClusterTopicFatigue", () => {
  it("is 0 for a topic that is not the current topic", () => {
    const state = createInitialClusterTopicState("group-1");
    expect(computeClusterTopicFatigue(state, "topic:a", 0.2, 0.05)).toBe(0);
  });

  it("grows with repetitionCount and is clamped to [0, 1]", () => {
    let state = createInitialClusterTopicState("group-1");
    state = recordUtterance(state, { topicId: "topic:a", speakerId: "agent-1", claimId: "claim:a", tick: 1 });
    const fatigueAfterOne = computeClusterTopicFatigue(state, "topic:a", 0.2, 0.05);
    expect(fatigueAfterOne).toBeCloseTo(0.15, 5);

    for (let i = 0; i < 20; i++) {
      state = recordUtterance(state, { topicId: "topic:a", speakerId: "agent-1", claimId: "claim:a", tick: 2 + i });
    }
    expect(computeClusterTopicFatigue(state, "topic:a", 0.2, 0.05)).toBe(1);
  });
});

describe("pruneClusterTopicRuntimeState", () => {
  it("drops entries for clusters that are no longer active and keeps the rest", () => {
    const runtime: ClusterTopicRuntimeState = {
      "group-1": createInitialClusterTopicState("group-1"),
      "group-2": createInitialClusterTopicState("group-2"),
    };
    const next = pruneClusterTopicRuntimeState(runtime, new Set(["group-1"]));
    expect(Object.keys(next)).toEqual(["group-1"]);
  });
});
