"use client"
// ============ /owner/users — SaaS owner RBAC management (§31) ============
import { useState } from "react"
import { Loader2, Plus, Save, ShieldOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, PageHeader, StatusChip, TableShell, Td, fmtDateTime, Loading } from "@/saas/owner/ui"
import { OWNER_ROLE_LABELS } from "@/saas/owner/rbac-shared"

type Row = {
  id: string; email: string; name: string; roleKey: string; roleLabel: string
  permissions: string[]; status: string; lastLoginAt: string | null; createdAt: string
  mfaEnrolled?: boolean
}

type RoleOption = { key: string; name: string; active: boolean }

export default function OwnerUsersPage() {
  const { data, loading, error, reload } = useOwnerApi<{ users: Row[] }>("owner.users.list", {})
  // custom roles (Roles & Permissions console) join the built-in templates
  const rolesQ = useOwnerApi<{ roles: RoleOption[] }>("owner.roles.list", {})
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [resetMfaFor, setResetMfaFor] = useState<Row | null>(null)
  const [form, setForm] = useState({
    id: "", email: "", name: "", roleKey: "SALES_MANAGER", permissions: [] as string[], status: "ACTIVE", password: "", resetMfa: false,
  })

  const openNew = () => { setForm({ id: "", email: "", name: "", roleKey: "SALES_MANAGER", permissions: [], status: "ACTIVE", password: "", resetMfa: false }); setFormError(null); setOpen(true) }
  const openEdit = (u: Row) => {
    setForm({ id: u.id, email: u.email, name: u.name, roleKey: u.roleKey, permissions: u.permissions, status: u.status, password: "", resetMfa: false })
    setFormError(null); setOpen(true)
  }

  const save = async () => {
    setBusy(true); setFormError(null)
    try {
      await ownerRpc("owner.users.save", {
        id: form.id || undefined,
        email: form.email, name: form.name, roleKey: form.roleKey as any,
        permissions: form.permissions, status: form.status as any,
        password: form.password || undefined,
        resetMfa: form.resetMfa || undefined,
      })
      setOpen(false); await reload()
    } catch (e: any) { setFormError(e?.message || "Save failed") } finally { setBusy(false) }
  }

  const resetMfa = async () => {
    if (!resetMfaFor) return
    setBusy(true)
    try {
      await ownerRpc("owner.users.save", {
        id: resetMfaFor.id, email: resetMfaFor.email, name: resetMfaFor.name, roleKey: resetMfaFor.roleKey,
        permissions: resetMfaFor.permissions, status: resetMfaFor.status, resetMfa: true,
      })
      setResetMfaFor(null); await reload()
    } catch (e: any) { alert(e?.message || "MFA reset failed") } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Owner Users"
        sub="The platform team. Granular permissions (owner.* vocabulary) — completely separate from tenant RBAC."
        actions={
          <Button onClick={openNew} className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
            <Plus className="h-4 w-4" /> Add owner user
          </Button>
        }
      />
      {error && <ErrorBanner message={error} />}
      {loading ? <Loading /> : (
        <TableShell headers={["Name", "Email", "Role", "Permissions", "MFA", "Status", "Last login", ""]} empty={data?.users.length === 0}>
          {data?.users.map((u) => (
            <tr key={u.id} className="cursor-pointer transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60 light:hover:bg-slate-50" onClick={() => openEdit(u)}>
              <Td className="font-medium text-white light:text-slate-900">{u.name}</Td>
              <Td className="text-xs">{u.email}</Td>
              <Td className="text-xs">{u.roleLabel}</Td>
              <Td className="text-xs text-slate-500">{u.permissions.length ? `${u.permissions.length} explicit` : "role template"}</Td>
              <Td>
                <span className={`text-[11px] font-semibold ${u.mfaEnrolled ? "text-emerald-300 light:text-emerald-700" : "text-slate-500"}`}>
                  {u.mfaEnrolled ? "Enabled" : "Off"}
                </span>
              </Td>
              <Td><StatusChip status={u.status === "ACTIVE" ? "ACTIVE" : "SUSPENDED"} /></Td>
              <Td className="text-xs">{fmtDateTime(u.lastLoginAt)}</Td>
              <Td className="whitespace-nowrap">
                <span className="text-xs text-indigo-300 light:text-indigo-700 light:text-indigo-600">edit →</span>
                {u.mfaEnrolled && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setResetMfaFor(u) }}
                    title="Reset this owner's MFA (super admin only) — for lost devices"
                    className="ml-2 text-xs text-red-300 light:text-red-600 hover:underline light:text-red-600"
                  >
                    reset MFA
                  </button>
                )}
              </Td>
            </tr>
          ))}
        </TableShell>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 light:border-slate-200 light:bg-white">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">{form.id ? `Edit ${form.name}` : "Add owner user"}</DialogTitle></DialogHeader>
          {formError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600 light:border-red-300 light:bg-red-50 light:text-red-700">{formError}</p>}
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:border-slate-300 light:bg-white light:text-slate-900" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:border-slate-300 light:bg-white light:text-slate-900" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Role</Label>
              <Select value={form.roleKey} onValueChange={(v) => setForm({ ...form, roleKey: v, permissions: [] })}>
                <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:border-slate-300 light:bg-white light:text-slate-900"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(rolesQ.data?.roles || []).map((r) => (
                    <SelectItem key={r.key} value={r.key} disabled={!r.active}>
                      {r.name}{!r.active ? " (inactive)" : ""}
                    </SelectItem>
                  ))}
                  {Object.entries(OWNER_ROLE_LABELS)
                    .filter(([k]) => !(rolesQ.data?.roles || []).some((r) => r.key === k))
                    .map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-slate-500">Empty permission list = full role template (recommended). Explicit lists override the template. Custom roles are managed under Roles &amp; Permissions.</p>
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">{form.id ? "Reset password (optional — min 12 chars)" : "Password (min 12 chars)"}</Label>
              <Input type="password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:border-slate-300 light:bg-white light:text-slate-900" placeholder="••••••••••••" />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300 light:text-slate-700">
              <Switch checked={form.status === "ACTIVE"} onCheckedChange={(v) => setForm({ ...form, status: v ? "ACTIVE" : "SUSPENDED" })} />
              Account active
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900 light:border-slate-300 light:bg-white light:text-slate-900">Cancel</Button>
            <Button onClick={save} disabled={busy || !form.name || !form.email || (!form.id && form.password.length < 12)}
              className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Save className="h-4 w-4" /> Save</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* MFA rescue dialog — super admins strip a lost second factor */}
      <Dialog open={!!resetMfaFor} onOpenChange={(v) => !v && setResetMfaFor(null)}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 light:border-slate-200 light:bg-white">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Reset MFA for {resetMfaFor?.name}?</DialogTitle></DialogHeader>
          <p className="text-sm leading-relaxed text-slate-400 light:text-slate-600">
            This removes the authenticator requirement and signs out every active session for <span className="font-semibold text-slate-200 light:text-slate-800">{resetMfaFor?.email}</span>.
            They will set up MFA again at their next sign-in (or from Settings → My Account). Use this only when the owner
            has lost their device and recovery codes.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setResetMfaFor(null)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900 light:border-slate-300 light:bg-white light:text-slate-900">Cancel</Button>
            <Button onClick={resetMfa} disabled={busy} className="bg-red-600 text-white light:text-slate-900 hover:bg-red-700">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><ShieldOff className="h-4 w-4" /> Reset MFA</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
