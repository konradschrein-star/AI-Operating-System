import { signIn } from "@/auth";
import { tokens } from "../tokens";

export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: tokens.bgBody,
        color: tokens.text,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <form
        action={async () => {
          "use server";
          await signIn("github", { redirectTo: "/" });
        }}
        style={{
          width: "100%",
          maxWidth: 360,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              background: tokens.accent,
            }}
          />
          <span style={{ fontSize: 18, fontWeight: 600 }}>forge</span>
        </div>
        <ErrorBlock searchParams={searchParams} />
        <button
          type="submit"
          style={{
            width: "100%",
            fontFamily: "inherit",
            fontSize: 14,
            padding: "12px 18px",
            borderRadius: 10,
            border: `1px solid ${tokens.borderEmphasis}`,
            background: tokens.bgCard,
            color: tokens.text,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
          }}
        >
          <GhMark />
          Sign in with GitHub
        </button>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.textFaint,
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          single-user system · only the allowlist gets in
        </div>
      </form>
    </div>
  );
}

async function ErrorBlock({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  if (!params.error) return null;
  return (
    <div
      className="mono"
      style={{
        width: "100%",
        background: tokens.dangerActionBg,
        border: `1px solid ${tokens.dangerActionBorder}`,
        color: tokens.bleed,
        borderRadius: 8,
        padding: "10px 12px",
        fontSize: 11.5,
        textAlign: "center",
      }}
    >
      {params.error === "AccessDenied"
        ? "not on the allowlist — sign-in rejected."
        : `auth error: ${params.error}`}
    </div>
  );
}

function GhMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.32-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.77.12 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.42.36.78 1.07.78 2.15 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.55C20.71 21.38 24 17.08 24 12 24 5.65 18.85.5 12 .5z" />
    </svg>
  );
}
