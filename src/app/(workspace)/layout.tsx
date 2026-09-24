import { Workspace } from "@/components/workspace";

export default function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <Workspace />
      {children}
    </>
  );
}
