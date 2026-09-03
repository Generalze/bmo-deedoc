import { runAdminGlobalStructureTests } from "./admin-global-structures.test";
import { runCandidatePublicTests } from "./candidate-public.test";
import { runElectionDayTests } from "./election-day.test";
import { runEdgeGovernanceTests } from "./edge-governance.test";
import { runEvidenceTests } from "./evidence.test";
import { runMemberAncestryTests } from "./member-ancestry.test";
import { runPhase1ArchitectureTests } from "./phase1-architecture.test";
import { runPreElectionTests } from "./pre-election.test";
import { runRealtimeTests } from "./realtime.test";

void (async () => {
  await runAdminGlobalStructureTests();
  await runCandidatePublicTests();
  await runElectionDayTests();
  await runEvidenceTests();
  await runEdgeGovernanceTests();
  await runMemberAncestryTests();
  await runPhase1ArchitectureTests();
  await runPreElectionTests();
  await runRealtimeTests();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
