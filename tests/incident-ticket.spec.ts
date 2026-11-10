/**
 * ServiceNow tickets on incidents: link checks, number extraction, the
 * prefilled new incident form and activity wording.
 * Requirements: REV-70; incident operations 15.
 */
import { expect, test } from "@playwright/test";
import {
  checkTicketInput,
  checkTicketNumber,
  describeTicketActivity,
  escapeQueryValue,
  newIncidentFormUrl,
  NEW_FORM_URL_MAX,
  numberFromLink,
  openableUrl,
  serviceNowBase,
  ticketDescriptionSuffix,
  ticketNumberUrl,
} from "../src/lib/incident-ticket";

const base = serviceNowBase("https://acme.service-now.com")!;
const mounted = serviceNowBase("https://sn.example.com/servicenow/")!;

test("a bare number becomes the configured ServiceNow's ticket address", () => {
  // Requirements: REV-70; incident operations 15.
  expect(checkTicketInput(" inc0041235 ", base)).toEqual({
    kind: "ok",
    url: "https://acme.service-now.com/nav_to.do?uri=task.do%3Fsysparm_query%3Dnumber%3DINC0041235",
    number: "INC0041235",
    fromNumber: true,
  });
  expect(ticketNumberUrl(mounted, "chg0001234")).toBe(
    "https://sn.example.com/servicenow/nav_to.do?uri=task.do%3Fsysparm_query%3Dnumber%3DCHG0001234",
  );
});

test("links are checked against the configured ServiceNow", () => {
  // Requirements: REV-70; incident operations 15.
  const link =
    "https://acme.service-now.com/nav_to.do?uri=incident.do?sysparm_query=number=INC0041235";
  expect(checkTicketInput(link, base)).toEqual({
    kind: "ok",
    url: link,
    number: "INC0041235",
    fromNumber: false,
  });
  const noNumber =
    "https://acme.service-now.com/now/nav/ui/classic/params/target/incident.do%3Fsys_id%3D9d385017";
  expect(checkTicketInput(noNumber, base)).toMatchObject({
    kind: "ok",
    number: null,
  });
  const error = (value: string, target = base) => {
    const result = checkTicketInput(value, target);
    return result.kind === "error" ? result.message : result.kind;
  };
  expect(error("")).toBe("empty");
  expect(error("see INC0041235 in SN")).toMatch(/^Paste a ServiceNow link/);
  expect(error("http://acme.service-now.com/x")).toBe(
    "The link must start with https://.",
  );
  expect(error("https://acme-dev.service-now.com/x")).toBe(
    "acme-dev.service-now.com isn’t the ServiceNow Keep uses. Only links to acme.service-now.com can be saved.",
  );
  expect(error("https://acme.service-now.com:8443/x")).toMatch(/isn’t the/);
  expect(error("https://user:pw@acme.service-now.com/x")).toMatch(
    /user name and password/,
  );
  expect(error("https://acme.service-now.com/a\tb")).toMatch(/spaces/);
  expect(error(`https://acme.service-now.com/${"a".repeat(2048)}`)).toMatch(
    /2,048/,
  );
  expect(error("https://sn.example.com/other/x", mounted)).toMatch(
    /must be under https:\/\/sn\.example\.com\/servicenow/,
  );
  expect(error("https://sn.example.com/servicenowx", mounted)).toMatch(
    /must be under/,
  );
  expect(
    checkTicketInput("https://sn.example.com/servicenow", mounted),
  ).toMatchObject({
    kind: "ok",
  });
  expect(error("INC0041235", null as unknown as URL)).toMatch(/isn't set up/);
});

test("numbers come from encoded links and the optional field", () => {
  // Requirements: REV-70; incident operations 15.
  expect(
    numberFromLink(
      "https://acme.service-now.com/nav_to.do?uri=task.do%253Fsysparm_query%253Dnumber%253Dinc0000042",
    ),
  ).toBe("INC0000042");
  expect(numberFromLink("https://x/?sysparm_number=INC0000042")).toBeNull();
  expect(checkTicketNumber("")).toEqual({ ok: true, number: null });
  expect(checkTicketNumber(" ritm0012345 ")).toEqual({
    ok: true,
    number: "RITM0012345",
  });
  expect(checkTicketNumber("12345")).toEqual({ ok: false });
});

test("the new incident form is prefilled, escaped and kept short", () => {
  // Requirements: REV-70; incident operations 15.
  expect(escapeQueryValue("a^b^^c")).toBe("a^^b^^^^c");
  const suffix = ticketDescriptionSuffix(
    "Critical",
    "https://keep.example/tenants/t1/incidents/i1",
  );
  const url = newIncidentFormUrl(base, "Checkout ^ slow", `Body${suffix}`);
  expect(
    url.startsWith(
      "https://acme.service-now.com/incident.do?sys_id=-1&sysparm_query=",
    ),
  ).toBe(true);
  const query = decodeURIComponent(url.split("sysparm_query=")[1]);
  expect(query).toBe(
    "short_description=Checkout ^^ slow^description=Body\n\nSeverity: Critical\nKeep incident: https://keep.example/tenants/t1/incidents/i1",
  );

  const long = `${"é".repeat(3000)}😀${"x".repeat(3000)}${suffix}`;
  const short = newIncidentFormUrl(base, "Title", long, suffix);
  expect(short.length).toBeLessThanOrEqual(NEW_FORM_URL_MAX);
  const description = decodeURIComponent(short.split("sysparm_query=")[1]);
  expect(description.endsWith(`…${suffix}`)).toBe(true);
  expect(description.length).toBeGreaterThan(100);

  // Edited away from the suffix: the end of the whole text is shortened.
  const edited = newIncidentFormUrl(base, "Title", "y".repeat(9000), suffix);
  expect(edited.length).toBeLessThanOrEqual(NEW_FORM_URL_MAX);
  expect(decodeURIComponent(edited).endsWith("…")).toBe(true);
});

test("ticket activity reads linked, changed and unlinked", () => {
  // Requirements: REV-70; incident operations 15.
  expect(
    describeTicketActivity({
      url: "https://a/x",
      number: "INC1234567",
      previous_url: null,
      previous_number: null,
    }),
  ).toEqual({ what: "ServiceNow ticket linked", to: "INC1234567" });
  expect(
    describeTicketActivity({
      url: null,
      number: null,
      previous_url: "https://a/x",
      previous_number: "INC1234567",
    }),
  ).toEqual({ what: "ServiceNow ticket unlinked", from: "INC1234567" });
  expect(
    describeTicketActivity({
      url: "https://a/y",
      number: null,
      previous_url: "https://a/x",
      previous_number: "INC1234567",
    }),
  ).toEqual({
    what: "ServiceNow ticket changed",
    from: "INC1234567",
    to: "ServiceNow ticket",
  });
  expect(openableUrl("javascript:alert(1)")).toBe(false);
  expect(openableUrl("https://acme.service-now.com/x")).toBe(true);
});
