-- Backfill ward constituency edge provenance for the checked-in Ogun release.
--
-- The preceding migration added the provenance columns with
-- `stateConstituencyEdgeInferred BOOLEAN NOT NULL DEFAULT false`, and only the
-- reference importer ever set them. Neither deploy path runs that importer, so
-- on a database that imported the Ogun identity release under PR #11 -- which is
-- every real one -- migrating forward left all 236 wards reading "sourced".
-- The fail-closed rule in `deriveMemberAncestryFromWard` then had nothing to
-- refuse, and registration on the 55 unreviewed wards would have succeeded
-- silently. A guard that cannot fail is not a guard; this makes it true of the
-- data, not just of the code.
--
-- The edges below are the 55 distinct wards named by the 56 rows of
-- `ogun-identity-2026-08-12/INFERRED-EDGES.csv`, resolved exactly as the
-- importer resolves them: by LGA and ward name, or by the build's internal
-- `lgaSourceCode:wardSourceCode` key, with the row matching the edge actually
-- loaded winning where a ward is named twice. They are inlined rather than read
-- at runtime because a migration must not depend on the filesystem.
--
-- Assertions are scoped to the release's own 236 wards rather than to every
-- Ogun ward, so a database that has legitimately acquired an additional ward is
-- still upgraded, while a database that does not carry this release is refused.
--
-- Review columns are deliberately untouched. The importer owns the inference;
-- human governance owns the review. Nothing here declares an edge reviewed.

DO $$
DECLARE
  release_ward_count integer;
  matched_count integer;
  inferred_count integer;
  sourced_count integer;
  reviews_before integer;
  reviews_after integer;
BEGIN
  CREATE TEMP TABLE _ogun_inferred_edges (
    ward_id text PRIMARY KEY,
    state_constituency_id text NOT NULL,
    basis text NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO _ogun_inferred_edges (ward_id, state_constituency_id, basis) VALUES
  ('inec-ward-6427', 'state-assembly-sc-726-og', 'token overlap (1)'),
  ('inec-ward-6436', 'state-assembly-sc-726-og', 'token overlap (1)'),
  ('inec-ward-6440', 'state-assembly-sc-726-og', 'token overlap (1)'),
  ('inec-ward-6444', 'state-assembly-sc-723-og', 'token overlap (1)'),
  ('inec-ward-6470', 'state-assembly-sc-748-og', 'token overlap (1)'),
  ('inec-ward-6472', 'state-assembly-sc-743-og', 'REVIEW: no name match'),
  ('inec-ward-6473', 'state-assembly-sc-743-og', 'REVIEW: no name match'),
  ('inec-ward-6474', 'state-assembly-sc-743-og', 'REVIEW: no name match'),
  ('inec-ward-6477', 'state-assembly-sc-743-og', 'REVIEW: no name match'),
  ('inec-ward-6479', 'state-assembly-sc-743-og', 'REVIEW: no name match'),
  ('inec-ward-6498', 'state-assembly-sc-730-og', 'sole constituency in LGA'),
  ('inec-ward-6506', 'state-assembly-sc-728-og', 'REVIEW: no name match'),
  ('inec-ward-6507', 'state-assembly-sc-728-og', 'REVIEW: no name match'),
  ('inec-ward-6508', 'state-assembly-sc-728-og', 'REVIEW: no name match'),
  ('inec-ward-6509', 'state-assembly-sc-728-og', 'REVIEW: no name match'),
  ('inec-ward-6510', 'state-assembly-sc-728-og', 'REVIEW: no name match'),
  ('inec-ward-6511', 'state-assembly-sc-729-og', 'REVIEW: constituency had no ward; moved from same-LGA sibling'),
  ('inec-ward-6523', 'state-assembly-sc-733-og', 'token overlap (1)'),
  ('inec-ward-6524', 'state-assembly-sc-733-og', 'sole constituency in LGA'),
  ('inec-ward-6530', 'state-assembly-sc-731-og', 'token overlap (1)'),
  ('inec-ward-6536', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6537', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6538', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6539', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6540', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6541', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6542', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6543', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6544', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6545', 'state-assembly-sc-737-og', 'sole constituency in LGA'),
  ('inec-ward-6547', 'state-assembly-sc-735-og', 'token overlap (1)'),
  ('inec-ward-6551', 'state-assembly-sc-735-og', 'token overlap (1)'),
  ('inec-ward-6555', 'state-assembly-sc-735-og', 'token overlap (1)'),
  ('inec-ward-6571', 'state-assembly-sc-742-og', 'token overlap (1)'),
  ('inec-ward-6576', 'state-assembly-sc-742-og', 'sole constituency in LGA'),
  ('inec-ward-6578', 'state-assembly-sc-745-og', 'token overlap (1)'),
  ('inec-ward-6583', 'state-assembly-sc-745-og', 'sole constituency in LGA'),
  ('inec-ward-6584', 'state-assembly-sc-745-og', 'sole constituency in LGA'),
  ('inec-ward-6586', 'state-assembly-sc-745-og', 'sole constituency in LGA'),
  ('inec-ward-6587', 'state-assembly-sc-745-og', 'token overlap (1)'),
  ('inec-ward-6588', 'state-assembly-sc-745-og', 'token overlap (1)'),
  ('inec-ward-6593', 'state-assembly-sc-727-og', 'token overlap (1)'),
  ('inec-ward-6609', 'state-assembly-sc-725-og', 'sole constituency in LGA'),
  ('inec-ward-6615', 'state-assembly-sc-736-og', 'token overlap (1)'),
  ('inec-ward-6616', 'state-assembly-sc-736-og', 'sole constituency in LGA'),
  ('inec-ward-6622', 'state-assembly-sc-736-og', 'token overlap (1)'),
  ('inec-ward-6637', 'state-assembly-sc-941-og', 'token overlap (1)'),
  ('inec-ward-6640', 'state-assembly-sc-941-og', 'sole constituency in LGA'),
  ('inec-ward-6642', 'state-assembly-sc-941-og', 'sole constituency in LGA'),
  ('inec-ward-6648', 'state-assembly-sc-738-og', 'token overlap (1)'),
  ('inec-ward-6649', 'state-assembly-sc-738-og', 'token overlap (1)'),
  ('inec-ward-6650', 'state-assembly-sc-738-og', 'token overlap (1)'),
  ('inec-ward-6651', 'state-assembly-sc-738-og', 'token overlap (1)'),
  ('inec-ward-6658', 'state-assembly-sc-739-og', 'token overlap (1)'),
  ('inec-ward-6659', 'state-assembly-sc-738-og', 'REVIEW: no name match');

  CREATE TEMP TABLE _ogun_sourced_wards (ward_id text PRIMARY KEY) ON COMMIT DROP;

  INSERT INTO _ogun_sourced_wards (ward_id) VALUES
  ('inec-ward-6425'),
  ('inec-ward-6426'),
  ('inec-ward-6428'),
  ('inec-ward-6429'),
  ('inec-ward-6430'),
  ('inec-ward-6431'),
  ('inec-ward-6432'),
  ('inec-ward-6433'),
  ('inec-ward-6434'),
  ('inec-ward-6435'),
  ('inec-ward-6437'),
  ('inec-ward-6438'),
  ('inec-ward-6439'),
  ('inec-ward-6441'),
  ('inec-ward-6442'),
  ('inec-ward-6443'),
  ('inec-ward-6445'),
  ('inec-ward-6446'),
  ('inec-ward-6447'),
  ('inec-ward-6448'),
  ('inec-ward-6449'),
  ('inec-ward-6450'),
  ('inec-ward-6451'),
  ('inec-ward-6452'),
  ('inec-ward-6453'),
  ('inec-ward-6454'),
  ('inec-ward-6455'),
  ('inec-ward-6456'),
  ('inec-ward-6457'),
  ('inec-ward-6458'),
  ('inec-ward-6459'),
  ('inec-ward-6460'),
  ('inec-ward-6461'),
  ('inec-ward-6462'),
  ('inec-ward-6463'),
  ('inec-ward-6464'),
  ('inec-ward-6465'),
  ('inec-ward-6466'),
  ('inec-ward-6467'),
  ('inec-ward-6468'),
  ('inec-ward-6469'),
  ('inec-ward-6471'),
  ('inec-ward-6475'),
  ('inec-ward-6476'),
  ('inec-ward-6478'),
  ('inec-ward-6480'),
  ('inec-ward-6481'),
  ('inec-ward-6482'),
  ('inec-ward-6483'),
  ('inec-ward-6484'),
  ('inec-ward-6485'),
  ('inec-ward-6486'),
  ('inec-ward-6487'),
  ('inec-ward-6488'),
  ('inec-ward-6489'),
  ('inec-ward-6490'),
  ('inec-ward-6491'),
  ('inec-ward-6492'),
  ('inec-ward-6493'),
  ('inec-ward-6494'),
  ('inec-ward-6495'),
  ('inec-ward-6496'),
  ('inec-ward-6497'),
  ('inec-ward-6499'),
  ('inec-ward-6500'),
  ('inec-ward-6501'),
  ('inec-ward-6502'),
  ('inec-ward-6503'),
  ('inec-ward-6504'),
  ('inec-ward-6505'),
  ('inec-ward-6512'),
  ('inec-ward-6513'),
  ('inec-ward-6514'),
  ('inec-ward-6515'),
  ('inec-ward-6516'),
  ('inec-ward-6517'),
  ('inec-ward-6518'),
  ('inec-ward-6519'),
  ('inec-ward-6520'),
  ('inec-ward-6521'),
  ('inec-ward-6522'),
  ('inec-ward-6525'),
  ('inec-ward-6526'),
  ('inec-ward-6527'),
  ('inec-ward-6528'),
  ('inec-ward-6529'),
  ('inec-ward-6531'),
  ('inec-ward-6532'),
  ('inec-ward-6533'),
  ('inec-ward-6534'),
  ('inec-ward-6535'),
  ('inec-ward-6546'),
  ('inec-ward-6548'),
  ('inec-ward-6549'),
  ('inec-ward-6550'),
  ('inec-ward-6552'),
  ('inec-ward-6553'),
  ('inec-ward-6554'),
  ('inec-ward-6556'),
  ('inec-ward-6557'),
  ('inec-ward-6558'),
  ('inec-ward-6559'),
  ('inec-ward-6560'),
  ('inec-ward-6561'),
  ('inec-ward-6562'),
  ('inec-ward-6563'),
  ('inec-ward-6564'),
  ('inec-ward-6565'),
  ('inec-ward-6566'),
  ('inec-ward-6567'),
  ('inec-ward-6568'),
  ('inec-ward-6569'),
  ('inec-ward-6570'),
  ('inec-ward-6572'),
  ('inec-ward-6573'),
  ('inec-ward-6574'),
  ('inec-ward-6575'),
  ('inec-ward-6577'),
  ('inec-ward-6579'),
  ('inec-ward-6580'),
  ('inec-ward-6581'),
  ('inec-ward-6582'),
  ('inec-ward-6585'),
  ('inec-ward-6589'),
  ('inec-ward-6590'),
  ('inec-ward-6591'),
  ('inec-ward-6592'),
  ('inec-ward-6594'),
  ('inec-ward-6595'),
  ('inec-ward-6596'),
  ('inec-ward-6597'),
  ('inec-ward-6598'),
  ('inec-ward-6599'),
  ('inec-ward-6600'),
  ('inec-ward-6601'),
  ('inec-ward-6602'),
  ('inec-ward-6603'),
  ('inec-ward-6604'),
  ('inec-ward-6605'),
  ('inec-ward-6606'),
  ('inec-ward-6607'),
  ('inec-ward-6608'),
  ('inec-ward-6610'),
  ('inec-ward-6611'),
  ('inec-ward-6612'),
  ('inec-ward-6613'),
  ('inec-ward-6614'),
  ('inec-ward-6617'),
  ('inec-ward-6618'),
  ('inec-ward-6619'),
  ('inec-ward-6620'),
  ('inec-ward-6621'),
  ('inec-ward-6623'),
  ('inec-ward-6624'),
  ('inec-ward-6625'),
  ('inec-ward-6626'),
  ('inec-ward-6627'),
  ('inec-ward-6628'),
  ('inec-ward-6629'),
  ('inec-ward-6630'),
  ('inec-ward-6631'),
  ('inec-ward-6632'),
  ('inec-ward-6633'),
  ('inec-ward-6634'),
  ('inec-ward-6635'),
  ('inec-ward-6636'),
  ('inec-ward-6638'),
  ('inec-ward-6639'),
  ('inec-ward-6641'),
  ('inec-ward-6643'),
  ('inec-ward-6644'),
  ('inec-ward-6645'),
  ('inec-ward-6646'),
  ('inec-ward-6647'),
  ('inec-ward-6652'),
  ('inec-ward-6653'),
  ('inec-ward-6654'),
  ('inec-ward-6655'),
  ('inec-ward-6656'),
  ('inec-ward-6657'),
  ('inec-ward-6660');

  SELECT count(*) INTO release_ward_count
    FROM "Ward" w
   WHERE w."stateId" = 'ng-state-ogun'
     AND (w."id" IN (SELECT ward_id FROM _ogun_inferred_edges)
       OR w."id" IN (SELECT ward_id FROM _ogun_sourced_wards));

  -- A database that has not yet imported the release has nothing to backfill:
  -- the importer sets provenance when it runs.
  IF release_ward_count = 0 THEN
    RAISE NOTICE 'Ogun identity release not present; provenance backfill skipped (importer will set it).';
    RETURN;
  END IF;

  SELECT count(*) INTO reviews_before
    FROM "Ward" WHERE "stateConstituencyEdgeReviewedAt" IS NOT NULL;

  -- Keyed on ward identity AND the constituency actually loaded for it. A
  -- database carrying a different release will not match, and is refused below
  -- rather than being marked with provenance that does not describe it.
  UPDATE "Ward" w
     SET "stateConstituencyEdgeInferred" = true,
         "stateConstituencyEdgeInferenceBasis" = e.basis
    FROM _ogun_inferred_edges e
   WHERE w."id" = e.ward_id
     AND w."stateId" = 'ng-state-ogun'
     AND w."stateConstituencyId" = e.state_constituency_id;

  GET DIAGNOSTICS matched_count = ROW_COUNT;

  SELECT count(*) INTO inferred_count
    FROM "Ward"
   WHERE "id" IN (SELECT ward_id FROM _ogun_inferred_edges)
     AND "stateConstituencyEdgeInferred" = true;

  SELECT count(*) INTO sourced_count
    FROM "Ward"
   WHERE "id" IN (SELECT ward_id FROM _ogun_sourced_wards)
     AND "stateConstituencyEdgeInferred" = false;

  SELECT count(*) INTO reviews_after
    FROM "Ward" WHERE "stateConstituencyEdgeReviewedAt" IS NOT NULL;

  IF release_ward_count <> 236 THEN
    RAISE EXCEPTION 'Found % of the release''s 236 wards; database does not match ogun-identity-2026-08-12.', release_ward_count;
  END IF;

  IF matched_count <> 55 THEN
    RAISE EXCEPTION 'Matched % inferred ward edges, expected 55; ward identity or loaded State Constituency does not match the canonical release.', matched_count;
  END IF;

  IF inferred_count <> 55 THEN
    RAISE EXCEPTION 'Release wards flagged inferred is %, expected 55.', inferred_count;
  END IF;

  IF sourced_count <> 181 THEN
    RAISE EXCEPTION 'Release wards left sourced is %, expected 181.', sourced_count;
  END IF;

  IF reviews_after <> reviews_before THEN
    RAISE EXCEPTION 'Backfill changed review metadata (% -> %); review is a governance act and must not be written here.', reviews_before, reviews_after;
  END IF;

  RAISE NOTICE 'Ogun ward provenance backfilled: % release wards, % inferred, % sourced, % reviews preserved.',
    release_ward_count, inferred_count, sourced_count, reviews_after;
END $$;
