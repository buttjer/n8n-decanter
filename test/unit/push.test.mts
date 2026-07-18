// Unit tests for the drift guard's pure comparison (lib/push.mts driftProblems).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { driftProblems } from "../../lib/push.mts";
import type { DecanterState, Workflow } from "../../lib/types.mts";
import { sha256, workflowStructureHash } from "../../lib/util.mts";

const CODE_A = "return [];\n";
const CODE_B = "return $input.all();\n";

const remoteWorkflow = (): Workflow => ({
  id: "wf1",
  name: "Test",
  connections: {},
  nodes: [
    { id: "n1", name: "Hook", type: "n8n-nodes-base.webhook", parameters: {} },
    { id: "n2", name: "Alpha", type: "n8n-nodes-base.code", parameters: { jsCode: CODE_A } },
    { id: "n3", name: "Beta", type: "n8n-nodes-base.code", parameters: { jsCode: CODE_B } },
  ],
});

const syncedState = (remote: Workflow): DecanterState => ({
  workflowId: "wf1",
  nodes: {
    n2: { file: "code/alpha.js", lastPushedHash: sha256(CODE_A) },
    n3: { file: "code/beta.js", lastPushedHash: sha256(CODE_B) },
  },
  lastPulledWorkflowHash: workflowStructureHash(remote),
});

describe("driftProblems", () => {
  it("reports nothing when hashes match the last sync", () => {
    const remote = remoteWorkflow();
    assert.deepEqual(driftProblems(remote, syncedState(remote)), []);
  });

  it("flags a remote Code node unknown locally", () => {
    const remote = remoteWorkflow();
    const state = syncedState(remote);
    delete state.nodes.n3;
    assert.deepEqual(driftProblems(remote, state), ['node "Beta" exists remotely but is unknown locally']);
  });

  it("flags per-node remote code drift", () => {
    const remote = remoteWorkflow();
    const state = syncedState(remote);
    remote.nodes[2].parameters.jsCode = CODE_B + "// UI hotfix\n";
    assert.deepEqual(driftProblems(remote, state), ['node "Beta": remote code changed since last sync']);
  });

  it("flags structure drift against lastPulledWorkflowHash", () => {
    const remote = remoteWorkflow();
    const state = syncedState(remote);
    remote.nodes.push({ id: "n4", name: "Set", type: "n8n-nodes-base.set", parameters: {} });
    assert.deepEqual(driftProblems(remote, state), ["workflow structure changed remotely since last sync (nodes/connections/settings)"]);
  });

  it("skips the structure check when lastPulledWorkflowHash is absent", () => {
    const remote = remoteWorkflow();
    const state = syncedState(remote);
    delete state.lastPulledWorkflowHash;
    remote.nodes.push({ id: "n4", name: "Set", type: "n8n-nodes-base.set", parameters: {} });
    assert.deepEqual(driftProblems(remote, state), []);
  });

  it("onlyNodeIds scopes to those nodes and skips the structure check", () => {
    const remote = remoteWorkflow();
    const state = syncedState(remote);
    // drift everywhere except n2: n3's code changed, structure changed
    remote.nodes[2].parameters.jsCode = CODE_B + "// UI hotfix\n";
    remote.nodes.push({ id: "n4", name: "Set", type: "n8n-nodes-base.set", parameters: {} });
    assert.deepEqual(driftProblems(remote, state, new Set(["n2"])), []);
    // the scoped node's own drift still surfaces
    assert.deepEqual(driftProblems(remote, state, new Set(["n3"])), ['node "Beta": remote code changed since last sync']);
  });
});
