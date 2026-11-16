import type { Metadata } from "next";
import { SignInForm } from "@/components/sign-in-form";
import "../styles/sign-in.css";

export const metadata: Metadata = { title: "Sign in · Keep" };

/**
 * Keep's own sign-in page (REV-73; identity configuration 1–2). It lives
 * outside `/auth`, which the Product API serves, and outside the workspace
 * catalog route, so it never runs the session check.
 */
export default function SignInPage() {
  return <SignInForm />;
}
