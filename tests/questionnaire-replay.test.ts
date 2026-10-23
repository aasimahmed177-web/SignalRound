import { expect, test } from "vitest";
import { requestBodyParameterNames, runQuestionnaireDryRun } from "../lib/questionnaire-replay";

test("captures request parameter names without values", () => {
  expect(
    requestBodyParameterNames("application/json", JSON.stringify({ email: "person@example.com", user: { phone: "+1 202-555-0147" } })),
  ).toEqual(["email", "user", "phone"]);
  expect(requestBodyParameterNames("application/x-www-form-urlencoded", "email=person%40example.com&score=9")).toEqual(["email", "score"]);
  expect(JSON.stringify(requestBodyParameterNames("application/json", '{"token":"secret"}'))).not.toContain("secret");
});

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")(
  "replays matched profiles, observes scores and blocks the write boundary",
  async () => {
    const read = async (url: string) => ({
      url,
      status: 200,
      contentType: "text/html",
      text: `<html><body>
        <label for="goal">Goal</label>
        <select id="goal" onchange="document.querySelector('[data-score]').textContent=this.value==='scaling'?'5':'0'">
          <option value="starting">Starting</option><option value="scaling">Scaling</option>
        </select>
        <form method="post">
          <button type="button" data-next onclick="document.querySelector('[data-result]').hidden=false;fetch('/collect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'fixture@example.com',score:5})}).catch(()=>{})">Next</button>
          <div data-result hidden>Score <span data-score>0</span></div>
          <button type="submit">Submit</button>
        </form>
      </body></html>`,
    });
    const result = await runQuestionnaireDryRun(
      {
        version: 1,
        mode: "interactive-dry-run",
        startUrl: "https://1.1.1.1/?utm_source=fixture",
        allowedOrigins: ["https://1.1.1.1"],
        steps: [
          { id: "goal", action: "select", selector: "#goal", answerKey: "goal", by: "value" },
          { id: "next", action: "click", selector: "[data-next]", intent: "next" },
          { id: "score", action: "observe", selector: "[data-score]" },
        ],
        profiles: [
          { id: "baseline", label: "Baseline", answers: { goal: "starting" } },
          { id: "variant", label: "Variant", answers: { goal: "scaling" } },
        ],
        scoreSelectors: ["[data-score]"],
        scoring: {
          version: 1,
          baseScore: 0,
          questions: [{ id: "goal", weights: { starting: 0, scaling: 5 } }],
          routes: [
            { id: "standard", minScore: 0, maxScore: 4 },
            { id: "qualified", minScore: 5 },
          ],
        },
      },
      { read },
    );
    expect(result.status).toBe("completed");
    expect(result.trials.map((trial) => trial.computed?.route)).toEqual(["standard", "qualified"]);
    expect(result.trials[1]?.comparison).toMatchObject({ scoreDelta: 5, routeChanged: true });
    expect(result.trials.every((trial) => trial.blockedWrites === 1)).toBe(true);
    expect(result.trials.flatMap((trial) => trial.network)).toContainEqual(
      expect.objectContaining({ method: "POST", outcome: "blocked-write", bodyParameterNames: ["email", "score"] }),
    );
    expect(JSON.stringify(result)).not.toContain("fixture@example.com");
    expect(JSON.stringify(result)).not.toContain('"starting"');
    expect(JSON.stringify(result)).not.toContain('"scaling"');
  },
  60_000,
);
