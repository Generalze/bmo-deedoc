import Link from "next/link";
import { PageHead, Panel } from "../../components/ui";

export default function TermsPage() {
  return (
    <main className="console-shell form-page">
      <PageHead
        title="Terms and conditions"
        lead="How voter registration data and campaign communication consent are handled on this platform."
        actions={
          <Link className="btn" href="/register">
            Back to registration
          </Link>
        }
      />

      <Panel title="Voter registration consent">
        <div className="stack-3">
          <p>
            By creating a voter account, you confirm that your registration details, including your Polling Unit and
            contact details, are accurate and belong to you.
          </p>
          <p>
            You confirm that you are 18 years old or above and legally eligible to register and participate as a voter.
          </p>
          <p>
            You consent to receive election, civic participation, campaign and operational messages connected to your
            registered territory, from authorised administrators and candidates operating within their permitted scope.
          </p>
          <p>
            Contact details are not open to all users. Export of voter email and phone records is restricted to the
            super admin for authorised operational use.
          </p>
          <p>
            Your territory relationship data may be used to organise outreach by Polling Unit, ward, local government,
            constituency, state, or other lawful political scope.
          </p>
        </div>
      </Panel>
    </main>
  );
}
