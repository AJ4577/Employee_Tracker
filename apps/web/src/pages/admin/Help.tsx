import { Section } from "../../ui/Layout";
import { PageHeader } from "../../ui/ui";

export default function Help() {
  return (
    <>
      <PageHeader title="How it works" />
      <Section title="Daily flow">
        <ol className="steps">
          <li><strong>Admin</strong> adds products and farmers, confirms each farmer's map pin, and records purchases.</li>
          <li><strong>Admin</strong> assigns a visit. The staff member gets an in-app notification and a push notification on the staff app.</li>
          <li><strong>Staff</strong> taps <em>Start duty</em> in the mobile app. Location is shared only while on duty, with a visible "Tracking on" indicator.</li>
          <li><strong>Staff</strong> taps <em>Start trip</em> (kab gaya), uses <em>Get directions</em> (Google Maps), then <em>Mark arrived</em> (kab pahuncha). If they are outside the arrival radius or GPS is weak, they add a reason and the arrival is flagged for review.</li>
          <li><strong>Staff</strong> records the outcome and completes the meeting (kab meeting done), optionally schedules a follow-up, then starts and ends the return trip (kab wapas aya), and ends duty.</li>
          <li><strong>Admin</strong> sees each timestamp separately in the visit page and the Visit timeline report. Anything not recorded shows "Not recorded".</li>
        </ol>
      </Section>
      <Section title="What the map shows">
        <ul>
          <li><strong>Live</strong>: staff is on duty with tracking and the last fix is recent. <strong>Stale</strong>: on duty but no recent fix. <strong>Last known</strong>: off duty — never shown as live.</li>
          <li>The green route line connects only real GPS points from the staff app. Gaps longer than 5 minutes are left unconnected. Google Maps directions are never drawn as an actual route.</li>
          <li>Address search results are approximate until an admin clicks the exact spot and confirms the pin.</li>
        </ul>
      </Section>
      <Section title="Browser vs. mobile app">
        <p>The web app works on desktop, tablet and phone browsers for managing and updating visits. Browsers cannot reliably record location while the phone is locked, so continuous trip tracking requires the KisanRoute Staff Android/iOS app. Staff using only the browser are on duty in "limited" mode (location captured only at the moment they tap Start / Arrive).</p>
      </Section>
      <Section title="Privacy">
        <p>Location is collected only between Start duty and End duty. Staff can see their own history; only admins of the same organization can see staff routes. Raw GPS points are deleted after the retention period set in Settings.</p>
      </Section>
    </>
  );
}
