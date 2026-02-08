// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy - OrcaBot",
  description: "Orcabot Privacy Policy",
};

export default function PrivacyPolicyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="subtitle">
        <strong>Effective Date:</strong> February 8, 2026 &middot; <strong>Last Updated:</strong> February 8, 2026
      </p>
      <p>
        This Privacy Policy describes how Rob Macrae (&ldquo;Orcabot,&rdquo;
        &ldquo;Company,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects,
        uses, and shares information when you use the Orcabot platform (&ldquo;Service&rdquo;). By
        using the Service, you agree to the practices described in this policy.
      </p>

      {/* Section 1 */}
      <h2>1. Information We Collect</h2>

      <h3>1.1 Account Information</h3>
      <p>When you sign up, we collect information from your Google account:</p>
      <ul>
        <li>
          <strong>Email address</strong> (used as your unique identifier)
        </li>
        <li>
          <strong>Name</strong> (from your Google profile)
        </li>
      </ul>
      <p>
        We do not collect passwords. Authentication is handled entirely through Google OAuth.
      </p>

      <h3>1.2 Customer Content</h3>
      <p>You create and store various types of content through the Service:</p>
      <ul>
        <li>
          <strong>Dashboard content</strong> &mdash; notes, configurations, layout, and canvas items
        </li>
        <li>
          <strong>Code and files</strong> &mdash; stored in your Sandbox workspace
        </li>
        <li>
          <strong>Prompts and AI interactions</strong> &mdash; commands you send to AI agents
        </li>
        <li>
          <strong>AI-generated output</strong> &mdash; code, text, and other content produced by AI
          agents
        </li>
        <li>
          <strong>Integration data</strong> &mdash; emails, files, calendar events, and other data
          accessed through connected services
        </li>
      </ul>

      <h3>1.3 Credentials You Provide</h3>
      <ul>
        <li>
          <strong>API keys</strong> &mdash; for AI providers (Anthropic, OpenAI, Google, etc.) and
          other services, stored encrypted via our secrets broker
        </li>
        <li>
          <strong>OAuth tokens</strong> &mdash; for connected Integrations (Gmail, GitHub, Google
          Drive, Calendar, Slack, etc.), stored encrypted in our control plane
        </li>
      </ul>

      <h3>1.4 Usage Data</h3>
      <p>We automatically collect data about how you use the Platform:</p>
      <ul>
        <li>Feature usage patterns (which tools and features you access)</li>
        <li>Performance metrics and error logs</li>
        <li>Session duration and activity timestamps</li>
      </ul>
      <p>
        Usage Data does <strong>not</strong> include the substance of your code, prompts, or AI
        outputs.
      </p>

      <h3>1.5 Limited Technical Data</h3>
      <ul>
        <li>
          <strong>Session cookie</strong> &mdash; a single authentication cookie (
          <code>orcabot_session</code>) stored in your browser
        </li>
        <li>
          <strong>IP address and user agent</strong> &mdash; collected only in specific security
          contexts (e.g., when confirming high-risk actions like sending emails through integrations)
        </li>
      </ul>

      <h3>1.6 What We Do NOT Collect</h3>
      <ul>
        <li>
          We do <strong>not</strong> use third-party analytics trackers (no Google Analytics,
          Mixpanel, Segment, etc.)
        </li>
        <li>
          We do <strong>not</strong> set third-party cookies
        </li>
        <li>
          We do <strong>not</strong> use tracking pixels or advertising SDKs
        </li>
        <li>
          We do <strong>not</strong> perform behavioral profiling or ad targeting
        </li>
      </ul>

      {/* Section 2 */}
      <h2>2. How We Use Your Information</h2>
      <p>We use the information we collect to:</p>
      <table>
        <thead>
          <tr>
            <th>Purpose</th>
            <th>Data Used</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Provide the Service (run Sandboxes, execute integrations, manage dashboards)</td>
            <td>Account info, Customer Content, credentials</td>
          </tr>
          <tr>
            <td>Authenticate your identity</td>
            <td>Account info, session cookie</td>
          </tr>
          <tr>
            <td>Execute Integration actions on your behalf</td>
            <td>OAuth tokens, integration policies</td>
          </tr>
          <tr>
            <td>Manage and protect your API keys via the secrets broker</td>
            <td>Encrypted secrets</td>
          </tr>
          <tr>
            <td>Send transactional communications (dashboard invitations, security alerts)</td>
            <td>Email address</td>
          </tr>
          <tr>
            <td>Maintain security and prevent abuse</td>
            <td>Usage data, audit logs, IP address (limited)</td>
          </tr>
          <tr>
            <td>Improve Platform reliability and performance</td>
            <td>Usage data, error logs</td>
          </tr>
          <tr>
            <td>Enforce our Terms of Service</td>
            <td>Account info, usage data, audit logs</td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>We do NOT use your information to:</strong>
      </p>
      <ul>
        <li>Train or fine-tune AI models (Orcabot is not an AI provider)</li>
        <li>Sell or rent your data to third parties</li>
        <li>Target advertising</li>
        <li>Build profiles for marketing purposes</li>
      </ul>

      {/* Section 3 */}
      <h2>3. How We Share Your Information</h2>
      <p>We share your information only in the following circumstances:</p>

      <h3>3.1 With Third-Party Services You Connect</h3>
      <p>
        When you connect Integrations or provide API keys, your data flows to those services as
        directed by you:
      </p>
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>Data Shared</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>Google</strong> (Gmail, Drive, Calendar, Contacts)
            </td>
            <td>OAuth tokens, API requests, queries</td>
            <td>Execute actions you authorize</td>
          </tr>
          <tr>
            <td>
              <strong>GitHub</strong>
            </td>
            <td>OAuth tokens, API requests</td>
            <td>Execute actions you authorize</td>
          </tr>
          <tr>
            <td>
              <strong>Slack, Discord, Telegram, etc.</strong>
            </td>
            <td>OAuth tokens, messages</td>
            <td>Execute actions you authorize</td>
          </tr>
          <tr>
            <td>
              <strong>AI Providers</strong> (Anthropic, OpenAI, Google, etc.)
            </td>
            <td>Your API keys, prompts, code</td>
            <td>Run AI agents with your keys</td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>Important:</strong> How these services handle your data is governed by{" "}
        <strong>their</strong> privacy policies, not ours. We act as an intermediary executing your
        requests. OAuth tokens never leave our control plane &mdash; API calls to these services are
        made server-side on your behalf.
      </p>

      <h3>3.2 With Dashboard Collaborators</h3>
      <p>
        When you share a Dashboard, collaborators can see Dashboard content and real-time presence
        information (cursor position, selected items, connection status). The Dashboard owner
        controls access.
      </p>

      <h3>3.3 With Service Providers</h3>
      <p>We use the following infrastructure providers to operate the Service:</p>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Purpose</th>
            <th>Data Processed</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>Cloudflare</strong> (Workers, D1, R2, Durable Objects)
            </td>
            <td>Control plane hosting, database, real-time collaboration</td>
            <td>Account data, encrypted credentials, dashboard content</td>
          </tr>
          <tr>
            <td>
              <strong>Fly.io</strong>
            </td>
            <td>Sandbox VM hosting</td>
            <td>Code, files, terminal sessions (in isolated VMs)</td>
          </tr>
          <tr>
            <td>
              <strong>Resend</strong>
            </td>
            <td>Transactional email delivery</td>
            <td>Recipient email address, invitation content</td>
          </tr>
        </tbody>
      </table>
      <p>These providers process data on our behalf under contractual obligations.</p>

      <h3>3.4 For Legal Compliance</h3>
      <p>
        We may disclose information if required by law, regulation, legal process, or government
        request. We will notify you where legally permitted.
      </p>

      <h3>3.5 Business Transfers</h3>
      <p>
        In connection with a merger, acquisition, or sale of assets, your information may be
        transferred to the successor entity.
      </p>

      {/* Section 4 */}
      <h2>4. Data Security</h2>

      <h3>4.1 Encryption</h3>
      <ul>
        <li>
          <strong>Secrets (API keys):</strong> Encrypted at rest using AES-256-GCM
        </li>
        <li>
          <strong>OAuth tokens:</strong> Encrypted at rest in our database
        </li>
        <li>
          <strong>In transit:</strong> All data transmitted over HTTPS/TLS; WebSocket connections use
          WSS
        </li>
        <li>
          <strong>Database:</strong> Cloudflare D1 provides encryption at rest
        </li>
      </ul>

      <h3>4.2 Secrets Broker</h3>
      <p>Our secrets broker is designed to prevent AI agents from exfiltrating your API keys:</p>
      <ul>
        <li>
          API keys are <strong>not</strong> set as environment variables in the Sandbox
        </li>
        <li>The broker injects keys server-side; AI agents only see placeholder values</li>
        <li>Secret values in terminal output are redacted before reaching your browser</li>
      </ul>

      <h3>4.3 Sandbox Isolation</h3>
      <p>
        Each Dashboard runs in a dedicated, isolated virtual machine. Sandboxes are designed to
        contain code execution, though isolation is provided on a best-effort basis.
      </p>

      <h3>4.4 Access Controls</h3>
      <ul>
        <li>Authentication via Google OAuth with HttpOnly, Secure session cookies</li>
        <li>Role-based access control for Dashboard collaboration (owner/editor/viewer)</li>
        <li>PTY-level cryptographic authentication (HMAC-SHA256 tokens) for terminal sessions</li>
        <li>Rate limiting on all API endpoints</li>
      </ul>

      <h3>4.5 Security Incident Response</h3>
      <p>
        If we become aware of a security incident affecting your data, we will notify you without
        undue delay via the email associated with your account, including details required for
        regulatory compliance. Notification of a security incident does not constitute an admission
        of fault or liability.
      </p>

      {/* Section 5 */}
      <h2>5. Data Retention</h2>
      <table>
        <thead>
          <tr>
            <th>Data Type</th>
            <th>Retention Period</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Account information</td>
            <td>Until you delete your account</td>
          </tr>
          <tr>
            <td>Session cookies</td>
            <td>30 days (auto-expire)</td>
          </tr>
          <tr>
            <td>Dashboard content</td>
            <td>Until the Dashboard is deleted</td>
          </tr>
          <tr>
            <td>Sandbox workspace files</td>
            <td>Until the Dashboard is deleted or Sandbox is terminated</td>
          </tr>
          <tr>
            <td>Encrypted secrets</td>
            <td>Until you delete them or your account is closed</td>
          </tr>
          <tr>
            <td>OAuth tokens</td>
            <td>Until you disconnect the Integration or your account is closed</td>
          </tr>
          <tr>
            <td>Integration audit logs</td>
            <td>12 months from creation</td>
          </tr>
          <tr>
            <td>Inbound messages (Slack, etc.)</td>
            <td>7 days</td>
          </tr>
          <tr>
            <td>Dashboard invitations</td>
            <td>Until accepted or expired</td>
          </tr>
        </tbody>
      </table>
      <p>
        After account deletion, we will delete or anonymize your data within 30 days, except where
        retention is required by law or necessary for legitimate business purposes (e.g., fraud
        prevention, legal compliance).
      </p>

      {/* Section 6 */}
      <h2>6. Your Rights and Choices</h2>

      <h3>6.1 Access and Portability</h3>
      <p>
        You can access your Dashboard content, workspace files, and account information through the
        Service at any time. You may export your workspace files through the Platform&apos;s file
        management tools.
      </p>

      <h3>6.2 Deletion</h3>
      <p>
        You may request deletion of your account and associated data by contacting us at
        privacy@orcabot.com. Upon request, we will delete your data in accordance with Section 5.
      </p>

      <h3>6.3 Integration Management</h3>
      <p>
        You can connect and disconnect third-party Integrations at any time through the Dashboard
        interface. Disconnecting an Integration revokes our access to that service on your behalf.
      </p>

      <h3>6.4 Secrets Management</h3>
      <p>
        You can add, view metadata for, and delete Secrets through the Platform&apos;s secrets
        management interface at any time.
      </p>

      <h3>6.5 Collaboration Controls</h3>
      <p>
        Dashboard owners can invite and remove collaborators, and control integration policies and
        permissions.
      </p>

      {/* Section 7 */}
      <h2>7. International Data Transfers</h2>
      <p>
        The Service is operated using infrastructure provided by Cloudflare (global edge network) and
        Fly.io (regional compute). Your data may be processed in jurisdictions outside your country
        of residence. By using the Service, you consent to the transfer of your data to these
        jurisdictions. We rely on our providers&apos; compliance frameworks (including
        Cloudflare&apos;s Data Processing Addendum) for lawful transfer mechanisms.
      </p>

      {/* Section 8 */}
      <h2>8. Children&apos;s Privacy</h2>
      <p>
        The Service is not directed to individuals under 18 years of age. We do not knowingly collect
        personal information from children. If we learn that we have collected data from a child
        under 18, we will take steps to delete it promptly.
      </p>

      {/* Section 9 */}
      <h2>9. California Privacy Rights (CCPA)</h2>
      <p>If you are a California resident, you have the right to:</p>
      <ul>
        <li>
          <strong>Know</strong> what personal information we collect and how it is used
        </li>
        <li>
          <strong>Delete</strong> your personal information (subject to legal exceptions)
        </li>
        <li>
          <strong>Opt out</strong> of the sale of personal information &mdash;{" "}
          <strong>we do not sell your personal information</strong>
        </li>
        <li>
          <strong>Non-discrimination</strong> for exercising your privacy rights
        </li>
      </ul>
      <p>To exercise these rights, contact us at privacy@orcabot.com.</p>

      {/* Section 10 */}
      <h2>10. European Privacy Rights (GDPR)</h2>
      <p>
        If you are located in the European Economic Area, United Kingdom, or Switzerland, you have
        additional rights under the GDPR, including the right to access, rectify, erase, restrict
        processing, data portability, and object to processing. Our lawful bases for processing are:
      </p>
      <ul>
        <li>
          <strong>Contract performance</strong> &mdash; to provide the Service you requested
        </li>
        <li>
          <strong>Legitimate interests</strong> &mdash; to maintain security, prevent fraud, and
          improve the Service
        </li>
        <li>
          <strong>Consent</strong> &mdash; where required (e.g., for optional data sharing)
        </li>
      </ul>
      <p>
        To exercise your rights or lodge a complaint, contact us at privacy@orcabot.com or your local
        supervisory authority.
      </p>

      {/* Section 11 */}
      <h2>11. Cookies</h2>
      <p>
        We use a <strong>single, first-party session cookie</strong> (<code>orcabot_session</code>):
      </p>
      <table>
        <thead>
          <tr>
            <th>Cookie</th>
            <th>Purpose</th>
            <th>Duration</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>orcabot_session</code>
            </td>
            <td>Authentication</td>
            <td>30 days</td>
            <td>Strictly necessary, first-party, HttpOnly</td>
          </tr>
        </tbody>
      </table>
      <p>
        We do not use analytics cookies, advertising cookies, or third-party tracking cookies.
      </p>

      {/* Section 12 */}
      <h2>12. Third-Party AI Providers</h2>
      <p>
        When you provide your own API keys and run AI agents through the Platform, your prompts and
        code are sent to your chosen AI Provider.{" "}
        <strong>Orcabot does not control how AI Providers handle your data.</strong> Each provider
        has its own privacy policy and data practices:
      </p>
      <ul>
        <li>
          <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer">
            Anthropic Privacy Policy
          </a>
        </li>
        <li>
          <a href="https://openai.com/privacy" target="_blank" rel="noopener noreferrer">
            OpenAI Privacy Policy
          </a>
        </li>
        <li>
          <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
            Google Privacy Policy
          </a>
        </li>
      </ul>
      <p>
        You are responsible for reviewing and accepting your AI Provider&apos;s privacy practices.
        Whether your AI Provider uses your data for model training is determined by your agreement
        with them, not by Orcabot.
      </p>

      {/* Section 13 */}
      <h2>13. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. Material changes will be communicated
        via email or in-product notice at least 30 days before they take effect. The &ldquo;Last
        Updated&rdquo; date at the top reflects the most recent revision.
      </p>

      {/* Section 14 */}
      <h2>14. Contact Us</h2>
      <p>
        For questions, concerns, or requests related to your privacy, contact us at:
      </p>
      <p>
        Rob Macrae
        <br />
        privacy@orcabot.com
      </p>
      <p>
        For data protection inquiries from the EU/UK, you may also contact our designated
        representative at privacy@orcabot.com.
      </p>
    </>
  );
}
