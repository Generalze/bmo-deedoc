import { Router } from "express";
import crypto from "node:crypto";
import {
  Prisma,
  ReferralStatus,
  UserRole,
  VoterVerificationDecision,
  VoterVerificationStatus,
} from "@prisma/client";
import { z } from "zod";
import { OGUN_STATE_ID, normalizeEmail } from "@pics-nigeria/shared";
import { signAccessToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { getAuthUserProfile } from "../auth/profile";
import { generateUniqueReferralCode } from "../auth/referral";
import {
  VoterDocumentRejected,
  storeVoterDocument,
  voterDocumentSubmissionSchema,
} from "../lib/voter-document-storage";
import { syncLgasForState, syncPollingUnitsForWard, syncWardsForLga } from "../lib/inec-reference";
import { deriveMemberAncestryFromWard, MemberAncestryError } from "../lib/member-ancestry";
import { validateTerritoryReferences } from "../lib/territory";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../prisma";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  agentGpsConsent: z.boolean().optional(),
});

const territoryQuerySchema = z.object({
  stateId: z.string().trim().min(1).optional(),
  lgaId: z.string().trim().min(1).optional(),
  wardId: z.string().trim().min(1).optional(),
});

const updateProfileSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().email(),
  phone: z.string().trim().min(7).max(30).optional().or(z.literal("")),
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8),
});

const registerVoterSchema = z.object({
  fullName: z.string().trim().min(2),
  email: z.string().email(),
  phone: z.string().trim().regex(/^\d{7,15}$/),
  password: z.string().min(8),
  voterCardNumber: z.string().trim().min(5),
  stateId: z.string().trim().min(1),
  lgaId: z.string().trim().min(1),
  wardId: z.string().trim().min(1),
  pollingUnitId: z.string().trim().min(1),
  referredByCode: z.string().trim().min(4).optional(),
  acceptTerms: z.boolean().optional(),
  acceptPrivacy: z.boolean().optional(),
  contactConsent: z.boolean().optional(),
  documentProcessingConsent: z.boolean().optional(),
  confirmAdult: z.boolean().optional(),
  consentVersion: z.string().trim().max(50).optional(),
  voterDocument: voterDocumentSubmissionSchema.optional(),
});

router.post("/login", async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid login payload.", errors: parsed.error.flatten() });
  }

  const user = await prisma.user.findUnique({
    where: { email: normalizeEmail(parsed.data.email) },
  });

  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return response.status(401).json({ message: "Invalid email or password." });
  }

  if (user.accountStatus === "SUSPENDED") {
    return response.status(403).json({ message: "This account has been suspended." });
  }

  if (!user.isActive || user.accountStatus === "INACTIVE") {
    return response.status(403).json({ message: "This account has been deactivated." });
  }

  let sessionNonce: string | undefined;
  const agentProfile = await prisma.agentProfile.findUnique({
    where: { userId: user.id },
    select: { userId: true, gpsTrackingConsentAt: true },
  });
  if (agentProfile) {

    if (!agentProfile.gpsTrackingConsentAt && parsed.data.agentGpsConsent !== true) {
      return response.status(400).json({
        message: "Agent sign-in requires GPS consent before access can be granted.",
      });
    }

    sessionNonce = crypto.randomUUID();
    await prisma.agentProfile.update({
      where: { userId: user.id },
      data: {
        gpsTrackingConsentAt: agentProfile.gpsTrackingConsentAt || new Date(),
        activeSessionNonce: sessionNonce,
      },
    });
  }

  const authUser = await getAuthUserProfile(user.id);
  if (!authUser) {
    return response.status(404).json({ message: "User profile not found." });
  }

  return response.json({
    token: signAccessToken(authUser, { sessionNonce }),
    user: authUser,
  });
});

router.get("/me", requireAuth, async (request, response) => {
  return response.json({ user: request.authUser });
});

router.post("/logout", requireAuth, async (request, response) => {
  if (request.authUser?.agentProfile) {
    await prisma.agentProfile.updateMany({
      where: { userId: request.authUser.id },
      data: { activeSessionNonce: null },
    });
  }

  return response.json({ message: "Signed out successfully." });
});

router.patch("/me", requireAuth, async (request, response) => {
  const parsed = updateProfileSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid profile update payload.", errors: parsed.error.flatten() });
  }

  const email = normalizeEmail(parsed.data.email);
  const phone = parsed.data.phone?.trim() ? parsed.data.phone.trim() : null;
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existingUser && existingUser.id !== request.authUser!.id) {
    return response.status(409).json({ message: "Email is already registered." });
  }

  await prisma.user.update({
    where: { id: request.authUser!.id },
    data: {
      name: parsed.data.name.trim(),
      email,
      phone,
    },
  });

  const authUser = await getAuthUserProfile(request.authUser!.id);
  return response.json({
    message: "Profile updated successfully.",
    user: authUser,
  });
});

/**
 * States offered to the public registration form.
 *
 * Feature 001: Ogun only. This used to backfill and return all 37 states, which
 * invited a registration the endpoint would then refuse — and the backfill
 * itself could crash the process. The national reference set still exists for
 * reporting and INEC alignment; it is simply not what a registrant chooses from.
 */
router.get("/territories/states", async (_request, response) => {
  const ogun = await prisma.state.findUnique({
    where: { id: OGUN_STATE_ID },
    select: { id: true, name: true },
  });

  return response.json({ states: ogun ? [ogun] : [] });
});

router.get("/territories/lgas", async (request, response) => {
  const parsed = territoryQuerySchema.safeParse(request.query);
  if (!parsed.success || !parsed.data.stateId) {
    return response.status(400).json({ message: "stateId is required." });
  }

  let lgas = await prisma.lGA.findMany({
    where: { stateId: parsed.data.stateId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true },
  });

  if (lgas.length === 0) {
    await syncLgasForState(prisma, parsed.data.stateId);
    lgas = await prisma.lGA.findMany({
      where: { stateId: parsed.data.stateId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, stateId: true },
    });
  }

  return response.json({ lgas });
});

router.get("/territories/wards", async (request, response) => {
  const parsed = territoryQuerySchema.safeParse(request.query);
  if (!parsed.success || !parsed.data.stateId || !parsed.data.lgaId) {
    return response.status(400).json({ message: "stateId and lgaId are required." });
  }

  let wards = await prisma.ward.findMany({
    where: {
      stateId: parsed.data.stateId,
      lgaId: parsed.data.lgaId,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true, lgaId: true },
  });

  if (wards.length === 0) {
    await syncWardsForLga(prisma, parsed.data.stateId, parsed.data.lgaId);
    wards = await prisma.ward.findMany({
      where: {
        stateId: parsed.data.stateId,
        lgaId: parsed.data.lgaId,
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, stateId: true, lgaId: true },
    });
  }

  return response.json({ wards });
});

router.get("/territories/polling-units", async (request, response) => {
  const parsed = territoryQuerySchema.safeParse(request.query);
  if (!parsed.success || !parsed.data.stateId || !parsed.data.lgaId || !parsed.data.wardId) {
    return response.status(400).json({ message: "stateId, lgaId, and wardId are required." });
  }

  await syncPollingUnitsForWard(prisma, parsed.data.stateId, parsed.data.lgaId, parsed.data.wardId);

  const pollingUnits = await prisma.pollingUnit.findMany({
    where: {
      stateId: parsed.data.stateId,
      lgaId: parsed.data.lgaId,
      wardId: parsed.data.wardId,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true, lgaId: true, wardId: true },
  });

  return response.json({ pollingUnits });
});

router.patch("/password", requireAuth, async (request, response) => {
  const parsed = updatePasswordSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid password update payload.", errors: parsed.error.flatten() });
  }

  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return response.status(400).json({ message: "New password must be different from the current password." });
  }

  const user = await prisma.user.findUnique({
    where: { id: request.authUser!.id },
    select: { id: true, passwordHash: true },
  });

  if (!user || !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return response.status(401).json({ message: "Current password is incorrect." });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
    },
  });

  return response.json({ message: "Password updated successfully." });
});

/**
 * Constituency ids a caller used to be able to send, and no longer may.
 *
 * Zod strips unknown keys, so leaving these unlisted would silently ignore them
 * — which looks identical, from the outside, to honouring them. A client still
 * sending one is working from a contract where it chose its own constituency,
 * and it should be told that changed rather than left to believe it worked.
 */
const SERVER_DERIVED_ANCESTRY_FIELDS = [
  "senatorialDistrictId",
  "federalConstituencyId",
  "stateConstituencyId",
] as const;

router.post("/register-voter", async (request, response) => {
  const suppliedAncestryFields = SERVER_DERIVED_ANCESTRY_FIELDS.filter(
    (field) => request.body !== null && typeof request.body === "object" && field in (request.body as object),
  );
  if (suppliedAncestryFields.length > 0) {
    return response.status(400).json({
      message: `Constituency ancestry is derived by the server from the selected ward and must not be supplied: ${suppliedAncestryFields.join(", ")}.`,
      code: "ANCESTRY_NOT_CALLER_SUPPLIED",
    });
  }

  const parsed = registerVoterSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid voter registration payload.", errors: parsed.error.flatten() });
  }

  // Legacy frontend bundles may omit these fields until all public clients refresh.
  if (parsed.data.acceptTerms === false || parsed.data.acceptPrivacy === false || parsed.data.contactConsent === false) {
    return response.status(400).json({
      message: "You must accept the terms and consent agreement to register.",
    });
  }

  if (parsed.data.voterDocument && parsed.data.documentProcessingConsent !== true) {
    return response.status(400).json({
      message: "Document processing consent is required before submitting voter evidence.",
    });
  }

  if (parsed.data.confirmAdult === false) {
    return response.status(400).json({
      message: "You must confirm that you are 18 years or older to register.",
    });
  }

  // Feature 001: the platform is purpose-built for Ogun State. Enforced on the
  // server because a client-side picker is a convenience, not a boundary — the
  // endpoint is public and unauthenticated, so anything it will accept is
  // reachable by anyone regardless of what the form offers.
  if (parsed.data.stateId !== OGUN_STATE_ID) {
    return response.status(400).json({
      message: "This platform operates in Ogun State only. Registration outside Ogun State is not available.",
      code: "OUTSIDE_OGUN_STATE",
    });
  }

  const email = normalizeEmail(parsed.data.email);
  const voterCardNumber = parsed.data.voterCardNumber.trim().toUpperCase();

  const [existingUser, existingVoterCard] = await Promise.all([
    prisma.user.findUnique({
      where: { email },
      include: {
        voterProfile: {
          select: { id: true },
        },
      },
    }),
    prisma.voterProfile.findUnique({ where: { voterCardNumber }, select: { id: true } }),
  ]);

  if (existingUser?.voterProfile) {
    return response.status(409).json({ message: "Voter details already exist for this email." });
  }

  if (existingVoterCard) {
    return response.status(409).json({ message: "Voter card number is already registered." });
  }

  if (existingUser && !(await verifyPassword(parsed.data.password, existingUser.passwordHash))) {
    return response.status(401).json({
      message: "This email already belongs to an existing account. Use the same account password to add voter details.",
    });
  }

  const territoryReferenceError = await validateTerritoryReferences(parsed.data);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  const ward = await prisma.ward.findUnique({
    where: { id: parsed.data.wardId },
    include: { lga: true },
  });

  if (!ward) {
    return response.status(400).json({ message: "Selected ward does not exist." });
  }

  if (ward.lgaId !== parsed.data.lgaId) {
    return response.status(400).json({ message: "Ward does not belong to the selected LGA." });
  }

  if (ward.stateId !== parsed.data.stateId || ward.lga.stateId !== parsed.data.stateId) {
    return response.status(400).json({ message: "Territory selection is inconsistent." });
  }

  const pollingUnit = await prisma.pollingUnit.findUnique({
    where: { id: parsed.data.pollingUnitId },
    include: { ward: true },
  });

  if (!pollingUnit) {
    return response.status(400).json({ message: "Selected polling unit does not exist." });
  }

  if (
    pollingUnit.wardId !== parsed.data.wardId ||
    pollingUnit.lgaId !== parsed.data.lgaId ||
    pollingUnit.stateId !== parsed.data.stateId ||
    pollingUnit.ward.lgaId !== parsed.data.lgaId
  ) {
    return response.status(400).json({ message: "Polling unit does not belong to the selected ward." });
  }

  let referrer: { id: string; email: string; referralCodeId: string | null; referralCode: string } | null = null;
  const referralCodeInput = parsed.data.referredByCode?.trim().toUpperCase();

  if (referralCodeInput) {
    const coordinatorReferralCode = await prisma.referralCode.findUnique({
      where: { code: referralCodeInput },
      include: {
        ownerUser: {
          select: { id: true, email: true },
        },
      },
    });
    const referrerProfile = coordinatorReferralCode
      ? null
      : await prisma.voterProfile.findUnique({
          where: { referralCode: referralCodeInput },
          include: {
            user: {
              select: { id: true, email: true },
            },
          },
        });

    if (!coordinatorReferralCode && !referrerProfile) {
      return response.status(400).json({ message: "Referral code is invalid." });
    }

    const owner = coordinatorReferralCode?.ownerUser || referrerProfile!.user;
    if (normalizeEmail(owner.email) === email) {
      return response.status(400).json({ message: "You cannot refer yourself." });
    }

    referrer = {
      id: owner.id,
      email: owner.email,
      referralCodeId: coordinatorReferralCode?.id || null,
      referralCode: referralCodeInput,
    };
  }

  const referralCode = await generateUniqueReferralCode();
  const passwordHash = await hashPassword(parsed.data.password);

  /**
   * Custody of the document is taken before the account exists.
   *
   * If storage refuses, the registration is refused with it. The alternative —
   * creating the member and recording a document that was never stored — is the
   * state this replaces, and it is worse than asking someone to try again.
   */
  let storedDocument: Awaited<ReturnType<typeof storeVoterDocument>> | null = null;
  if (parsed.data.voterDocument) {
    try {
      storedDocument = await storeVoterDocument({
        submission: parsed.data.voterDocument,
        // The account does not exist yet; the document is attributed to the
        // verification it is about to be attached to.
        memberUserId: "pending-registration",
      });
    } catch (caught) {
      if (caught instanceof VoterDocumentRejected) {
        return response.status(caught.status).json({ message: caught.message, code: caught.code });
      }
      throw caught;
    }
  }

  let createdUser;
  try {
    createdUser = await prisma.$transaction(async (transaction) => {
      /**
       * Derived inside the transaction, from the ward, and read through the same
       * transaction that writes the profile. If it throws, nothing above it has
       * been committed, so a registration is either complete with a proven
       * ancestry or it does not exist.
       */
      const ancestry = await deriveMemberAncestryFromWard(transaction, {
        stateId: parsed.data.stateId,
        lgaId: parsed.data.lgaId,
        wardId: parsed.data.wardId,
        pollingUnitId: parsed.data.pollingUnitId,
      });

      const voterProfileData: Prisma.VoterProfileUncheckedCreateWithoutUserInput = {
        voterCardNumber,
        referralCode,
        referredByUserId: referrer?.id || null,
        contactConsent: parsed.data.contactConsent ?? true,
        termsAcceptedAt: new Date(),
        privacyAcceptedAt: new Date(),
        documentConsentAt: parsed.data.voterDocument ? new Date() : null,
        consentVersion: parsed.data.consentVersion || "pre-election-v1",
        stateId: ancestry.stateId,
        senatorialDistrictId: ancestry.senatorialDistrictId,
        federalConstituencyId: ancestry.federalConstituencyId,
        lgaId: ancestry.lgaId,
        wardId: ancestry.wardId,
        stateConstituencyId: ancestry.stateConstituencyId,
        pollingUnitId: ancestry.pollingUnitId,
      };

      const user = existingUser
        ? await transaction.user.update({
            where: { id: existingUser.id },
            data: {
              phone: existingUser.phone || parsed.data.phone.trim(),
              voterProfile: {
                create: voterProfileData,
              },
            },
          })
        : await transaction.user.create({
            data: {
              name: parsed.data.fullName.trim(),
              email,
              phone: parsed.data.phone.trim(),
              passwordHash,
              role: UserRole.VOTER,
              voterProfile: {
                create: voterProfileData,
              },
            },
          });

      const duplicateDocument = storedDocument
        ? await transaction.voterVerificationDocument.findFirst({
            where: {
              // The server's hash of the bytes it stored. Comparing a
              // client-supplied hash made this check both evadable and abusable.
              sha256: storedDocument.sha256,
              verification: {
                memberUserId: { not: user.id },
              },
            },
            select: { id: true },
          })
        : null;

      const verification = await transaction.voterVerification.create({
        data: {
          memberUserId: user.id,
          voterIdentifier: voterCardNumber,
          status: storedDocument ? VoterVerificationStatus.PENDING : VoterVerificationStatus.NOT_SUBMITTED,
          isFlagged: Boolean(duplicateDocument),
          fraudReason: duplicateDocument ? "DUPLICATE_DOCUMENT_HASH" : null,
          submittedAt: storedDocument ? storedDocument.serverReceivedAt : null,
          documents: storedDocument
            ? {
                create: {
                  id: storedDocument.documentId,
                  originalStorageKey: storedDocument.originalStorageKey,
                  previewStorageKey: null,
                  originalFileName: storedDocument.originalFileName,
                  mimeType: storedDocument.mimeType,
                  // Derived from the bytes the server received, never asserted
                  // by the registering client.
                  fileSize: storedDocument.fileSize,
                  sha256: storedDocument.sha256,
                  storageProvider: storedDocument.storageProvider,
                  storageBucket: storedDocument.storageBucket,
                  serverReceivedAt: storedDocument.serverReceivedAt,
                },
              }
            : undefined,
        },
      });

      await transaction.voterVerificationHistory.create({
        data: {
          verificationId: verification.id,
          actorUserId: user.id,
          fromStatus: null,
          toStatus: verification.status,
          decision: storedDocument
            ? duplicateDocument
              ? VoterVerificationDecision.FLAGGED
              : VoterVerificationDecision.SUBMITTED
            : VoterVerificationDecision.NOTE_ADDED,
          note: parsed.data.voterDocument
            ? duplicateDocument
              ? "Registration evidence submitted and flagged for duplicate document hash."
              : "Registration evidence submitted for validation."
            : "Registration completed without voter evidence submission.",
        },
      });

      if (referrer) {
        await transaction.referral.create({
          data: {
            referredUserId: user.id,
            referrerUserId: referrer.id,
            referralCodeId: referrer.referralCodeId,
            referralCode: referrer.referralCode,
            status: duplicateDocument ? ReferralStatus.FLAGGED : ReferralStatus.PENDING_VERIFICATION,
            flaggedAt: duplicateDocument ? new Date() : null,
            fraudReason: duplicateDocument ? "DUPLICATE_DOCUMENT_HASH" : null,
          },
        });
      }

      return user;
    });
  } catch (error) {
    /**
     * The transaction has already rolled back by the time this runs, so a
     * refused ancestry leaves no user, no profile, no verification record and
     * no referral — the registration simply did not happen.
     */
    if (error instanceof MemberAncestryError) {
      return response.status(400).json({ message: error.message, code: error.code });
    }
    throw error;
  }

  const authUser = await getAuthUserProfile(createdUser.id);

  return response.status(201).json({
    message: "Voter registration successful.",
    user: authUser,
  });
});

export default router;
