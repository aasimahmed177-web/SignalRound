import { describe, expect, test } from "vitest";
import { classifyEmailIntent, splitEmailIntent } from "../lib/job-email-intent";

describe("classifyEmailIntent", () => {
  test("postings that print an address only for help, adjustments or questions", () => {
    const cases: Array<[string, string]> = [
      [
        "askhr@lumenarts.example",
        "If you experience any difficulties while submitting your application, please email askhr@lumenarts.example",
      ],
      [
        "hr@harbour-group.example",
        "If you have a disability and would like reasonable adjustments made to support your application to Harbour Group, contact hr@harbour-group.example or ring the HR team on 01632 960137.",
      ],
      [
        "recruitment@wattleexample.com.au",
        "…uld like to discuss adjustments to our hiring process, you are welcome to write to recruitment@wattleexample.com.au or ring our accessibility line on +61 2 5550 1234.",
      ],
      ["careers@brightwell.example", "For general and additional inquiries, you can reach us at careers@brightwell.example."],
      ["dana.okafor@larkspur.example", "Recruitment Partner: Dana.Okafor@Larkspur.example"],
      [
        "applicationassistance@meridianstays.example",
        "If you would like to apply for a role with Meridian Stays and need special assistance to do so, please send an email to: applicationassistance@meridianstays.example.",
      ],
      [
        "careers@fernbank.example",
        "For technical support or questions about Fernbank's hiring process, please send an email to Careers@fernbank.example",
      ],
      [
        "pq42@northvaleexample.ac.uk",
        "For an informal discussion about the post, contact Robin Ashdown at pq42@northvaleexample.ac.uk; note that applications must go through the university website.",
      ],
      [
        "careers@kestrelexample.org.uk",
        "If you'd like to know how we can support you by adjusting our process, from applying through to interview and your first weeks, please contact careers@kestrelexample.org.uk.",
      ],
      [
        "talentacquisition@corvidexample.com",
        "If you're unsure about the legitimacy of a job offer, please write to talentacquisition@corvidexample.com to verify that the message really came from Corvid.",
      ],
      [
        "careers@tidewayexample.co.uk",
        "For any questions about how we handle data processing for HR purposes, please contact Imogen Hale at careers@tidewayexample.co.uk.",
      ],
    ];
    for (const [email, quote] of cases) expect(classifyEmailIntent(email, quote), email).toBe("contact_only");
  });

  test("Indigenous-employment and recruiter-partnership desks are contacts, not inboxes", () => {
    const quote =
      "Indigenous applicants are welcome to get in touch with our Indigenous Careers team at firstpeoples@southgateexample.edu.au . … * Questions about our recruitment process can go to hr-careers@southgateexample.edu.au";
    expect(splitEmailIntent(["firstpeoples@southgateexample.edu.au", "hr-careers@southgateexample.edu.au"], quote)).toEqual({
      apply: [],
      contactOnly: ["firstpeoples@southgateexample.edu.au", "hr-careers@southgateexample.edu.au"],
    });
    expect(
      classifyEmailIntent(
        "recruitingpartnerships@halyard.example",
        "If your agency would like to work with Halyard, please email your company details and standard agreement to RecruitingPartnerships@Halyard.example.",
      ),
    ).toBe("contact_only");
  });

  test("privacy, dpo, legal, security, accessibility and noreply addresses are never application inboxes", () => {
    for (const email of [
      "privacy@acme.example",
      "dpo@acme.example",
      "legal@acme.example",
      "security@acme.example",
      "accessibility@acme.example",
      "noreply@acme.example",
      "no-reply@acme.example",
    ])
      expect(classifyEmailIntent(email, `Send your CV to ${email}`), email).toBe("contact_only");
  });

  test("application inboxes, including bare addresses and lines that also mention a phone contact", () => {
    const cases: Array<[string, string | null]> = [
      [
        "hrglowderm@gmail.com",
        "If you're an SEO specialist who cares about healthcare and skin health, send your CV to hrglowderm@gmail.com or call +91 00000 12345.",
      ],
      ["hr@quillonexample.co", "How to apply: send the items below to hr@quillonexample.co by 8 December 2026:"],
      ["weiling@pandanbakes.example", "Apply / enquiries: weiling@pandanbakes.example"],
      [
        "hr@veltrixexample.com",
        "Please send your updated resume to hr@veltrixexample.com or reach us at +91 00000 56158 for further details.",
      ],
      ["inquiry@dalisayexample.ph", "Interested applicants may send their curriculum vitae to inquiry@dalisayexample.ph"],
      ["careers@orchidtradingexample.com", "Email: careers@orchidtradingexample.com"],
      ["info@saffronlabsexample.ae", "info@saffronlabsexample.ae"],
      ["jobs@acme.example", null],
    ];
    for (const [email, quote] of cases) expect(classifyEmailIntent(email, quote), email).toBe("apply");
  });

  test("reads each address's own line when the quote joins several", () => {
    const quote =
      "For an informal chat about the post please contact Morgan Ellery, Marketing Manager, at Morgan.Ellery@hollinsexample.co.uk … To apply, please fill in the application form and the equal opportunities monitoring form from our website (www.hollinsexample.co.uk) and send both back to HRrecruitment@hollinsexample.co.uk";
    expect(splitEmailIntent(["morgan.ellery@hollinsexample.co.uk", "hrrecruitment@hollinsexample.co.uk"], quote)).toEqual({
      apply: ["hrrecruitment@hollinsexample.co.uk"],
      contactOnly: ["morgan.ellery@hollinsexample.co.uk"],
    });
  });
});
