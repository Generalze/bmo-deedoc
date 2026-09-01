import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient, UserRole } from "@prisma/client";
import { normalizeEmail } from "@pics-nigeria/shared";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl?.startsWith("file:")) {
  const relativePath = databaseUrl.slice("file:".length);
  if (!path.isAbsolute(relativePath)) {
    process.env.DATABASE_URL = `file:${path.resolve(__dirname, "../prisma", relativePath)}`;
  }
}

const prisma = new PrismaClient();

async function main() {
  const email = normalizeEmail(process.env.SUPER_ADMIN_EMAIL || "superadmin@pics.ng");
  const passwordLabel = process.env.SUPER_ADMIN_PASSWORD ? "from SUPER_ADMIN_PASSWORD env" : "ChangeMe123! (local fallback)";
  const superAdmin = await prisma.user.findFirst({
    where: { role: UserRole.SUPER_ADMIN, email },
    select: { name: true, email: true, role: true },
  });

  console.log("Seeded credentials summary");
  console.log(`super_admin_exists=${superAdmin ? "yes" : "no"}`);
  console.log(`email=${email}`);
  console.log(`password=${passwordLabel}`);
  console.log("sample_accounts:");
  console.log("state_admin_email=state.admin@pics.ng");
  console.log("state_admin_password=StateAdmin123!");
  console.log("candidate_email=candidate@pics.ng");
  console.log("candidate_password=Candidate123!");
  console.log("agent_email=agent@pics.ng");
  console.log("agent_password=Agent123!");
  console.log("voter_email=voter@pics.ng");
  console.log("voter_password=Voter123!");
  console.log("starter_territories:");
  console.log("state=ng-state-ogun");
  console.log("senatorialDistrict=seed-senatorial-ogun-central");
  console.log("federalConstituency=seed-fed-abeokuta-south");
  console.log("lga=seed-lga-abeokuta-south");
  console.log("wardA=seed-ward-abeokuta-south-a");
  console.log("wardB=seed-ward-abeokuta-south-b");
  console.log("stateConstituency=seed-state-const-abeokuta-south-1");
  console.log("pollingUnit=seed-pu-abeokuta-south-001");
}

main().finally(async () => {
  await prisma.$disconnect();
});
