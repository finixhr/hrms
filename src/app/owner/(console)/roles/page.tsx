"use client"
// ============ /owner/roles — Roles & Permissions management ============
// Owner-console role manager: view/create/edit roles, assign & remove
// permissions (grouped matrix), activate/deactivate, delete custom roles.
// Server-side everything is permission-gated (roles.view / roles.manage) and
// audited; this page only mirrors that gating visually.
import { useMemo, useState } from "react"
import { Loader2, Trash2, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, PageHeader, StatusChip, TableShell, Td, fmtDateTime, Loading } from "@/saas/owner/ui"
import { OWNER_PERMISSION_GROUPS, OWNER_PERMISSION_LABELS } from "@/saas/owner/rbac-shared"

type RoleRow = {
  id: string; key: string; name: string; description: string
  permissions: string[]; isSystem: boolean; active: boolean
  userCount: number; createdAt: string | null; updatedAt: string | null
}

type Form = {
  id: string; key: string; name: string; description: string
  permissions: string[]; active: boolean; isSystem: boolean; userCount: number
}

const BLANK_FORM: Form = {
  id: "", key: "", name: "", description: "", permissions: [], active: true, isSystem: false, userCount: 0,
}

export default function OwnerRolesPage() {
  const { data, loading, error, reload } = useOwnerApi<{ roles: RoleRow[] }>("owner.roles.list", {})
  const me = useOwnerApi<{ owner: { permissions: string[] } }>("owner.auth.me", {})
  const canManage = useMemo(() => !!me.data?.owner?.permissions?.includes("roles.manage"), [me.data])

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Form>(BLANK_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteFor, setDeleteFor] = useState<RoleRow | null>(null)

  const openNew = () => { setForm(BLANK_FORM); setFormError(null); setOpen(true) }
  const openEdit = (r: RoleRow) => {
    setForm({
      id: r.id, key: r.key, name: r.name, description: r.description,
      permissions: [...r.permissions], active: r.active, isSystem: r.isSystem, userCount: r.userCount,
    })
    setFormError(null); setOpen(true)
  }

  const togglePerm = (perm: string) => {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(perm)
        ? f.permissions.filter((p) => p !== perm)
        : [...f.permissions, perm],
    }))
  }
  const toggleGroup = (group: { perms: string[] }, on: boolean) => {
    setForm((f) => ({
      ...f,
      permissions: on
        ? Array.from(new Set([...f.permissions, ...group.perms]))
        : f.permissions.filter((p) => !group.perms.includes(p)),
    }))
  }

  const save = async () => {
    setBusy(true); setFormError(null)
    try {
      await ownerRpc("owner.roles.save", {
        id: form.id || undefined,
        key: form.key.trim().toUpperCase(),
        name: form.name.trim(),
        description: form.description.trim(),
        permissions: form.permissions,
        active: form.active,
      })
      setOpen(false); await reload()
    } catch (e: any) { setFormError(e?.message || "Save failed") } finally { setBusy(false) }
  }

  const toggleActive = async (r: RoleRow, active: boolean) => {
    setBusy(true)
    try {
      await ownerRpc("owner.roles.toggle", { id: r.id, active })
      await reload()
    } catch (e: any) { alert(e?.message || "Toggle failed") } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!deleteFor) return
    setBusy(true)
    try {
      await ownerRpc("owner.roles.delete", { id: deleteFor.id })
      setDeleteFor(null); await reload()
    } catch (e: any) { alert(e?.message || "Delete failed") } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Roles & Permissions"
        sub="Owner-console roles and their permission grants. Built-in roles are editable but not deletable; custom roles can be created, edited, activated, deactivated and deleted. Users with explicit permission lists are unaffected by role changes."
        actions={
          canManage ? (
            <Button onClick={openNew} className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
              Create role
            </Button>
          ) : undefined
        }
      />
      {error && <ErrorBanner message={error} />}
      {loading ? <Loading /> : (
        <TableShell headers={["Role", "Key", "Type", "Permissions", "Users", "Status", "Updated", ""]} empty={data?.roles.length === 0}>
          {data?.roles.map((r) => (
            <tr key={r.key} className="cursor-pointer transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60 light:hover:bg-slate-50" onClick={() => openEdit(r)}>
              <Td className="font-medium text-white light:text-slate-900">
                {r.name}
                {r.description && <p className="mt-0.5 max-w-xs truncate text-[11px] font-normal text-slate-500">{r.description}</p>}
              </Td>
              <Td className="font-mono text-xs">{r.key}</Td>
              <Td className="text-xs">{r.isSystem ? "Built-in" : "Custom"}</Td>
              <Td className="text-xs text-slate-500">{r.permissions.length} granted</Td>
              <Td className="text-xs">{r.userCount}</Td>
              <Td>
                <div onClick={(e) => e.stopPropagation()}>
                  <StatusChip status={r.active ? "ACTIVE" : "SUSPENDED"} />
                </div>
              </Td>
              <Td className="text-xs">{fmtDateTime(r.updatedAt || r.createdAt)}</Td>
              <Td className="whitespace-nowrap">
                {canManage && (
                  <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400 light:text-slate-600" title={r.key === "SUPER_ADMIN" ? "SUPER_ADMIN cannot be deactivated" : r.active ? "Deactivate this role" : "Activate this role"}>
                      <Switch
                        checked={r.active}
                        disabled={busy || r.key === "SUPER_ADMIN"}
                        onCheckedChange={(v) => toggleActive(r, v)}
                      />
                      {r.active ? "active" : "inactive"}
                    </label>
                    <button type="button" onClick={() => openEdit(r)} title="View / edit role" className="text-xs text-indigo-300 light:text-indigo-700 hover:underline">
                      edit →
                    </button>
                    {!r.isSystem && (
                      <button type="button" onClick={() => setDeleteFor(r)} title="Delete role" className="flex items-center gap-1 text-xs text-red-300 light:text-red-600 hover:underline">
                        <Trash2 className="h-3.5 w-3.5" /> delete
                      </button>
                    )}
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </TableShell>
      )}

      {/* ---- create / edit dialog with grouped permission matrix ---- */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 light:bg-white">
          <DialogHeader>
            <DialogTitle className="text-white light:text-slate-900">
              {form.id ? (canManage ? `Edit role — ${form.name}` : `Role details — ${form.name}`) : "Create role"}
            </DialogTitle>
          </DialogHeader>
          {formError && <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{formError}</p>}
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs text-slate-400 light:text-slate-600">Role name</Label>
                <Input
                  value={form.name}
                  readOnly={!canManage}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Regional Manager"
                  className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:text-slate-900"
                />
              </div>
              <div>
                <Label className="text-xs text-slate-400 light:text-slate-600">Key {form.isSystem && "(immutable — built-in)"}</Label>
                <Input
                  value={form.key}
                  readOnly={!canManage || form.isSystem}
                  onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
                  placeholder="REGIONAL_MANAGER"
                  className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 font-mono text-xs light:bg-slate-100 light:text-slate-900"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Description</Label>
              <Input
                value={form.description}
                readOnly={!canManage}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What this console role is for"
                className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:text-slate-900"
              />
            </div>
            {form.id && (
              <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3 text-xs leading-relaxed text-slate-400 light:text-slate-600">
                {form.userCount} owner user(s) hold this role. {form.userCount > 0 ? "Users with an explicit permission list keep their own grants; everyone else derives permissions from this role on next sign-in." : ""}
                {form.key === "SUPER_ADMIN" && " The SUPER_ADMIN role is the break-glass role — it cannot be deactivated."}
              </p>
            )}
            <label className="flex items-center gap-2 text-xs text-slate-300 light:text-slate-700">
              <Switch checked={form.active} disabled={!canManage || form.key === "SUPER_ADMIN"} onCheckedChange={(v) => setForm({ ...form, active: v })} />
              Role active {form.key === "SUPER_ADMIN" && "(locked on for SUPER_ADMIN)"}
            </label>

            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-500">
                Permissions ({form.permissions.length} granted)
              </p>
              <div className="mt-2 space-y-2">
                {OWNER_PERMISSION_GROUPS.map((g) => {
                  const grantedCount = g.perms.filter((p) => form.permissions.includes(p)).length
                  const allOn = grantedCount === g.perms.length
                  return (
                    <div key={g.key} className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[13px] font-semibold text-white light:text-slate-900">{g.label}</p>
                        {canManage && (
                          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400 light:text-slate-600">
                            <Checkbox
                              checked={allOn}
                              onCheckedChange={(v) => toggleGroup(g, v === true)}
                              aria-label={allOn ? `Remove all ${g.label} permissions` : `Grant all ${g.label} permissions`}
                            />
                            {allOn ? "remove all" : "grant all"} ({grantedCount}/{g.perms.length})
                          </label>
                        )}
                      </div>
                      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {g.perms.map((perm) => (
                          <label key={perm} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-slate-300 light:text-slate-700 hover:bg-white/[0.04] light:hover:bg-white">
                            <Checkbox
                              checked={form.permissions.includes(perm)}
                              onCheckedChange={() => togglePerm(perm)}
                              disabled={!canManage}
                              aria-label={OWNER_PERMISSION_LABELS[perm] || perm}
                            />
                            <span className="min-w-0 flex-1">
                              {OWNER_PERMISSION_LABELS[perm] || perm}
                              <span className="ml-1 font-mono text-[10px] text-slate-500">{perm}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          {canManage && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 text-white light:text-slate-900">Cancel</Button>
              <Button
                onClick={save}
                disabled={busy || !form.name.trim() || !form.key.trim()}
                className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Save className="h-4 w-4" /> {form.id ? "Save role" : "Create role"}</>}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- delete confirm ---- */}
      <Dialog open={!!deleteFor} onOpenChange={(v) => !v && setDeleteFor(null)}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 light:bg-white">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Delete role {deleteFor?.name}?</DialogTitle></DialogHeader>
          <p className="text-sm leading-relaxed text-slate-400 light:text-slate-600">
            This permanently removes the <span className="font-mono text-xs">{deleteFor?.key}</span> role.
            {deleteFor && deleteFor.userCount > 0 ? " Users currently holding it must be reassigned first." : " No users currently hold this role."}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFor(null)} className="border-white/10 light:border-slate-200 bg-white/5 text-white light:text-slate-900">Cancel</Button>
            <Button onClick={remove} disabled={busy} className="bg-red-600 text-white hover:bg-red-700">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Trash2 className="h-4 w-4" /> Delete role</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
