import { ACADEMY_COURSES, ACADEMY_SECTIONS } from "@events-os/shared";

export type GoogleChatCard = {
  cardId: string;
  card: {
    header: { title: string; subtitle?: string };
    sections: Array<{ widgets: GoogleChatWidget[] }>;
  };
};

export type GoogleChatWidget =
  | { image: { imageUrl: string; altText: string } }
  | { textParagraph: { text: string } }
  | { decoratedText: { topLabel: string; text: string } }
  | {
      buttonList: {
        buttons: Array<{
          text: string;
          onClick: { openLink: { url: string } };
        }>;
      };
    };

export type LinkPreviewResponse = {
  actionResponse: { type: "UPDATE_USER_MESSAGE_CARDS" };
  cardsV2: GoogleChatCard[];
};

export type WorkspaceAddonLinkPreviewResponse = {
  hostAppDataAction: {
    chatDataAction: {
      updateInlinePreviewAction: {
        cardsV2: GoogleChatCard[];
      };
    };
  };
};

export type OgMetadata = {
  title: string;
  description: string;
  image: string;
  url: string;
  siteName: string;
};

export type ChapterOsTarget =
  | { kind: "project"; id: string }
  | { kind: "academyModule"; slug: string }
  | { kind: "academyCourse"; slug: string }
  | { kind: "person"; id: string };

const MAX_TITLE = 120;
const MAX_SUBTITLE = 80;
const MAX_TEXT = 600;
const MAX_LABEL = 120;

export function extractMatchedUrl(event: unknown): string | null {
  const message =
    objectAtPath(event, ["message"]) ??
    objectAtPath(event, ["chat", "messagePayload", "message"]);
  if (!message || typeof message !== "object") return null;
  const matchedUrl = (message as { matchedUrl?: unknown }).matchedUrl;
  if (!matchedUrl || typeof matchedUrl !== "object") return null;
  const url = (matchedUrl as { url?: unknown }).url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

export function extractChatUserEmail(event: unknown): string | null {
  const user =
    objectAtPath(event, ["user"]) ?? objectAtPath(event, ["chat", "user"]);
  if (!user || typeof user !== "object") return null;
  const email = (user as { email?: unknown }).email;
  return typeof email === "string" && email.includes("@")
    ? email.trim().toLowerCase()
    : null;
}

export function buildNoPreviewResponse(): Record<string, never> {
  return {};
}

export function isWorkspaceAddonEvent(event: unknown): boolean {
  return objectAtPath(event, ["chat", "messagePayload", "message"]) != null;
}

export function adaptForEventEnvelope(
  response: LinkPreviewResponse,
  event: unknown,
): LinkPreviewResponse | WorkspaceAddonLinkPreviewResponse {
  if (!isWorkspaceAddonEvent(event)) return response;
  return {
    hostAppDataAction: {
      chatDataAction: {
        updateInlinePreviewAction: {
          cardsV2: response.cardsV2,
        },
      },
    },
  };
}

export function buildOgPreviewResponse(og: OgMetadata): LinkPreviewResponse {
  return buildCardResponse({
    cardId: "og-preview",
    title: og.title,
    subtitle: og.siteName,
    imageUrl: og.image || undefined,
    body: og.description,
    buttonText: "Open link",
    buttonUrl: og.url,
  });
}

export function buildUrlPreviewFallbackResponse(rawUrl: string): LinkPreviewResponse {
  const url = safeUrl(rawUrl);
  const hostname = url?.hostname.replace(/^www\./, "") ?? "Link";
  return buildCardResponse({
    cardId: "url-preview",
    title: hostname,
    subtitle: "Link preview",
    body: url?.href ?? rawUrl,
    buttonText: "Open link",
    buttonUrl: url?.href ?? rawUrl,
  });
}

export function buildCardResponse({
  cardId,
  title,
  subtitle,
  imageUrl,
  body,
  fields = [],
  buttonText,
  buttonUrl,
}: {
  cardId: string;
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  body?: string | null;
  fields?: Array<{ label: string; value: string | null | undefined }>;
  buttonText: string;
  buttonUrl: string;
}): LinkPreviewResponse {
  const widgets: GoogleChatWidget[] = [];
  if (imageUrl) {
    widgets.push({
      image: { imageUrl, altText: truncate(clean(title), MAX_LABEL) },
    });
  }
  if (body?.trim()) {
    widgets.push({
      textParagraph: { text: truncate(clean(body), MAX_TEXT) },
    });
  }
  for (const field of fields) {
    if (!field.value?.trim()) continue;
    widgets.push({
      decoratedText: {
        topLabel: truncate(clean(field.label), MAX_SUBTITLE),
        text: truncate(clean(field.value), MAX_LABEL),
      },
    });
  }
  widgets.push({
    buttonList: {
      buttons: [
        {
          text: buttonText,
          onClick: { openLink: { url: buttonUrl } },
        },
      ],
    },
  });
  return {
    actionResponse: { type: "UPDATE_USER_MESSAGE_CARDS" },
    cardsV2: [
      {
        cardId,
        card: {
          header: {
            title: truncate(clean(title), MAX_TITLE),
            ...(subtitle?.trim()
              ? { subtitle: truncate(clean(subtitle), MAX_SUBTITLE) }
              : {}),
          },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

export function parseChapterOsTarget(
  rawUrl: string,
  appBaseUrl: string | null | undefined,
): ChapterOsTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const base = appBaseUrl?.trim() ? safeUrl(appBaseUrl) : null;
  const productionHost = "publicworship.life";
  const appHost = base?.hostname ?? null;
  const appBasePath = (base?.pathname ?? "/os").replace(/\/+$/, "") || "";
  const hostMatches =
    url.hostname === productionHost || (appHost != null && url.hostname === appHost);
  if (!hostMatches) return null;

  let path = url.pathname.replace(/\/+$/, "");
  if (appBasePath && path === appBasePath) return null;
  if (appBasePath && path.startsWith(`${appBasePath}/`)) {
    path = path.slice(appBasePath.length);
  } else if (url.hostname === productionHost && path.startsWith("/os/")) {
    path = path.slice("/os".length);
  }
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] === "project" && segments[1]) {
    return { kind: "project", id: segments[1] };
  }
  if (segments[0] === "academy" && segments[1] === "course" && segments[2]) {
    return { kind: "academyCourse", slug: segments[2] };
  }
  if (segments[0] === "academy" && segments[1]) {
    return { kind: "academyModule", slug: segments[1] };
  }
  if (segments[0] === "team" && segments[1]) {
    return { kind: "person", id: segments[1] };
  }
  return null;
}

export function academyCoursePreview(slug: string) {
  const course = ACADEMY_COURSES.find((c) => c.slug === slug);
  if (!course) return null;
  const required = course.moduleSlugs.filter(
    (moduleSlug) =>
      ACADEMY_SECTIONS.find((section) => section.slug === moduleSlug)?.optional !==
      true,
  );
  return {
    title: course.title,
    description: course.description,
    level: course.level,
    moduleCount: course.moduleSlugs.length,
    requiredCount: required.length,
  };
}

export function academyModulePreview(slug: string) {
  const section = ACADEMY_SECTIONS.find((s) => s.slug === slug);
  if (!section) return null;
  const course = ACADEMY_COURSES.find((c) => c.moduleSlugs.includes(slug));
  return {
    title: section.title,
    description: section.subtitle,
    minutes: section.minutes,
    courseTitle: course?.title ?? null,
    isCapstone: section.capstone != null,
    optional: section.optional === true,
  };
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  const cleaned = clean(value);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function objectAtPath(event: unknown, path: string[]): unknown {
  let current = event;
  for (const segment of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
