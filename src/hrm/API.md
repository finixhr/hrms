# HRM API Action Reference (RPC: POST /api/hrm { action, payload })

All calls via `rpc(action, payload)` / `useApi(action, payload)`.
Responses: `{ ok: true, data }` or thrown Error(message).

## Auth
- `auth.login` { email, password } → { token, user, vendor, settings } (public)
- `auth.me` {} → { user, vendor, settings }

## Organization (already built in organization.tsx)
- `branches.list|create|update|delete`, `departments.*`, `designations.*`, `shifts.*`
- `holidays.list` {year} | `holidays.create` {name,date,type,branchId} | `holidays.delete` {id}
- `rosters.list` {} | `rosters.assign` {employeeId,shiftId,fromDate,toDate?} | `rosters.delete` {id}
- `workflows.list` {} → workflows with steps | `workflows.save` {processType,name,steps[],active}
- `settings.get` {} | `settings.save` {group, values} | `settings.patch` {group, values} (L-13: partial update — send only changed keys; other keys in the group are preserved server-side)
- `events.list` {year} | `events.create` {title,type,date,time?,description?} | `events.delete` {id}
- `users.list|save|delete` (**users module** — R3-3/RBAC-104: split out of settings.edit; admins/owners hold users.*, HR_MANAGER has users.view only) — users.save: {id?, email, password?, name, role, employeeId?, branchId?, departmentId?, status}; demoting/suspending/deleting the last active VENDOR_OWNER is refused. `roles.save|delete` likewise require users.edit (roles.list stays settings.view)
- `roles.templates` {} → role permission templates
- `system.selfTest` {} → hardening checks { results: [{name,pass,detail}], allPass }

## Employees (already built)
- `employees.list` {q?,status?,branchId?,departmentId?,employmentType?} → decorated employees
- `employees.get` {id} → { employee, structure, family, education, references, prevEmployment, banks, docs, history, promotions, transfers, revisions, lookups } — R3-3 field projection: structure + revisions are withheld (null/[]) unless the caller holds payroll.view (FLD-101); every doc row's docNumber and employee.nid/identityNumber are masked to "•••• 1234" unless the caller holds employeeDocs.reveal (FLD-102); employee.salaryVisible / employee.identityNumberVisible markers tell the client which affordance to render. A masked identity value sent back to employees.update is treated as UNCHANGED
- `employees.create|update` / `employees.<section>.create|update|delete` for sections: family, education, references, prevEmployment, banks, docs
- `employees.bulkImport` {rows[], dryRun?} → { created, total, results[{row,status,detail}] } (R1 — Excel/CSV wizard; headers alias-mapped; dryRun validates without writing)
- `employees.docs.download` {id} → { fileName, fileData(base64), docType } (audited)
- `employees.docs.view` {id} → { fileName, fileData(base64), mimeType, title, docType } (audited popup preview — R6)
- `employees.docs.verify` {id, verified}
- `lifecycle.promote` {employeeId,newDesignationId?,newDepartmentId?,newGrade?,newBasicSalary?,effectiveDate,reason}
- `lifecycle.transfer` {employeeId,toBranchId?,toDepartmentId?,toDesignationId?,toManagerId?,toShiftId?,workLocation?,effectiveDate,reason}
- `lifecycle.reviseSalary` {employeeId,newGross,effectiveDate,reason}
- `lifecycle.pending` {employeeId} / `lifecycle.history` {employeeId}

## Attendance
- `attendance.today` {date?} → [{ employeeId, code, fullName, branchName, departmentName, shiftName, record, impliedStatus }]
- `attendance.mark` {employeeId, date, checkIn "HH:MM"?, checkOut?, status? (PRESENT/ABSENT/LEAVE/HOLIDAY/WEEKLY_OFF/WFH/BUSINESS_TRIP), remarks?} → recomputed record
- `attendance.bulkMark` {date, employeeIds[], checkIn, checkOut}
- `attendance.register` {month, year, employeeId?, branchId?, departmentId?} → records + employeeName
- `attendance.summary` {month, year, employeeId?} → aggregates
- `attendance.corrections.list` {status?} / `.request` {employeeId, date, requestedIn?, requestedOut?, reason} / `.act` {id, decision: APPROVED|REJECTED}
- `attendance.devices.list|create` ; `attendance.devices.sync` {deviceId, date?} → {imported, duplicates, date}
- `devices.syncHistory` {id, mode: CHECK|DATA_QUERY, fromDate?, toDate?} → { command, windowDays, activeUntil, note } (R8 — widened ingest window for old punches, active 60 min)
- `devices.syncHistory.stop` {id} → { stopped: true } (R8 — close the widened window early)
- `attendance.selfCheckout` {employeeId?} (EMPLOYEE role checks out self; plain check-out without GPS)
- `attendance.geofence.checkin` {employeeId?, latitude, longitude, accuracyM?, deviceInfo?} → validates branch radius/operating hours

## Leave
- `leaveTypes.list` {} / `leaveTypes.save` {id?, code, name, paid, defaultDays, carryForward, maxCarryForward, encashmentAllowed, waitingPeriodDays, probationEligible, requiresAttachment, active}
- `leaveBalances.recompute` {year?} / `leaveBalances.list` {year?, employeeId?} → [{typeName, employeeName, entitled, used, pending, remaining}]
- `leaveRequests.list` {status?, employeeId?, myTeam?} → [{typeName, employeeName, substituteName, ...}]
- `leaveRequests.apply` {employeeId?, leaveTypeId, fromDate, toDate, reason, halfDay?, substituteEmployeeId?, attachmentName?, attachmentData?}
  (EMPLOYEE role applies for self; server validates balance, probation, backdate, substitute eligibility)
- `leaveRequests.attachment` {id} → { fileName, fileData(base64), mimeType } (R3 — audited; owner, assigned substitute or leave.view/approve/edit holders)
- `leaveRequests.substitute.respond` {id, decision: ACCEPTED|DECLINED, comment?}
- `leaveRequests.cancel` {id}
- `leaveRequests.substituteOptions` {employeeId?, fromDate, toDate} → [{id, fullName, eligible, reason, sameBranch, sameDepartment}]
- `wishes.today` {} → { birthdays: [{employeeId,name,message}], anniversaries: [{name,years,message}] }

## Payroll
- `salaryStructures.list` {employeeId?, currentOnly?, all?} / `.save` {id?, employeeId, effectiveFrom, basic, houseRent, medical, conveyance, food, mobileAllow, internetAllow, attendanceAllow, otherAllowance, components?}
- `payroll.runs.list` {} → runs [{periodMonth, periodYear, status, totals...}]
- `payroll.runs.create` {periodMonth, periodYear, periodWeek?, runType?="REGULAR"} → only REGULAR runs are creatable (PAY-002: BONUS / FINAL_SETTLEMENT / ADJUSTMENT are rejected — adjustments come from payroll.adjustmentCreate, final settlements from the Exit module)
- `payroll.calculate` {runId} → { count, totalGross, totalNet }; for ADJUSTMENT runs the entries and totals are DELTAS vs the paid source run (PAY-001)
- `payroll.submitApproval` {runId} → creates approval request (status → HR_REVIEW)
- `payroll.pay` {runId} → payslips + journals + loan/advance recovery (needs APPROVED); adjustment runs post a delta journal and mark their source entries ADJUSTED
- `payroll.adjustmentCreate` {runId} → { adjustmentRunId }
- `payroll.entries` {runId} → { run, entries: [{employeeName, breakdown:{earnings[],deductions[],attendance{}}, ...}] }
- `bonuses.list` {status?, type?} → rows carry `escalated: true` while a PENDING bonus awaits the BONUS approval workflow / `bonuses.create` {employeeId, type, calcType: FIXED|PERCENT|FORMULA, amount?|percent?+baseAmount?, periodMonth?, periodYear?, label} / `bonuses.approve` {id, decision} — bonuses at/above the escalation threshold return {status: "ESCALATED"} and ride the BONUS workflow instead (PAY-006)
- `bonuses.approveBulk` {ids[], decision} → { actioned, escalated[], skipped[], aggregate: {count, sum, byType} } — bulk approval with the TOTAL BDT exposure computed before anything is actioned (PAY-006)
- `commissionRules.list` / `.save` {id?, name, basis: PERCENT_OF_SALES|FLAT, rate, minSales?, cap?, branchId?, designationId?, active} / `.delete` {id} — rate validated (percent ≤ 100, no negatives; PAY-011)
- `commissions.calculate` {month, year, entries: [{employeeId, salesAmount>0}]} → { created, skipped[], bonuses } — zod-validated, SoD-stamped (createdBy), period+rule dedup, deterministic most-specific-first rule precedence (PAY-004)
- `deductions.list` {employeeId?} / `deductions.save` {id?, employeeId, type, label, amount, month, year, recurring} / `deductions.delete` {id}
- `payroll.preflight` {periodMonth, periodYear} → { counts, ready[], warning[], blocked[], bonusExposure: { approved{count,sum,byType}, pending{count,sum,items}, commissionTotal, festivalPaidThisFy, payrollGross, exposurePct, exposureWarning } } (PAY-005)
- `payslips.list` {runId?, employeeId?} → [{entryId, payslipNumber, employeeName, period, status, gross, net, ait}]
- `payslips.html` {entryId} → { html } — open in new window (print-ready); print via URL +"?print=1" inside a blob window; the entry must be inside the caller's employee scope (PAY-012)

## AIT / Income Tax (Income Tax Act 2023 — the ONLY tax setup home)
All rule configuration lives per fiscal year and is managed from the AIT / Income Tax page → Fiscal Year Config tab.
- `ait.config.get` {fiscalYearId?} → { config: { fiscalYear, categories[], slabs[], ... } } (active year by default)
- `ait.fiscalYears.list` {} / `ait.fiscalYears.save` {id?, label, incomeYear, assessmentYear, tdsSectionRef?, exemptionFraction?, exemptionCap?, minimumTax?, rebateRate?, investmentCapFraction?, investmentCapAmount?, festivalBonusCount?, notes?} / `ait.fiscalYears.activate` {id} / `ait.fiscalYears.seedDefaults` {}
- `ait.categories.save` {fiscalYearId, categories: [{code, label, threshold, autoRule?: AGE_GE_65|GENDER_FEMALE, sortOrder}]}
- `ait.slabs.save` {fiscalYearId, slabs: [{slabLabel, upperLimit?, ratePercent, order}]}
- `ait.employee.profile` {employeeId} → tax profile + TDS YTD / `ait.employee.save` {employeeId, taxCategory?, declaredInvestment?, previousEmployerIncome?, festivalBonusOverride?, annualGrossOverride?}
- `ait.calc.preview` {employeeId?, taxpayerCategory?, dateOfBirth?, monthlyBasicSalary, monthlyGrossSalary, currentMonthGross?, declaredInvestment?, annualGrossOverride?, festivalBonusOverride?, previousEmployerIncome?, tdsYtd?} → { input, result: {lines, slabLines, warnings, annualTax, monthlyTds, averageRatePercent, ...} }
- `ait.calc.save` {input, result} → audit journal row (CALCULATOR source)
- `ait.batch.calculate` {branchId?} or {csvRows: [{name, basic, gross, category?, dob?, investment?}]} → { fiscalYear, results[], summary } (BATCH source; journals every row)
- `ait.batch.results` {take?} → recent batch journal rows
- `ait.reconciliation` {} → { fiscalYear, window, summary: { employees, monthsElapsed, totalEstimated, totalDeducted, totalGap, shortfall, surplus }, rows: [{employeeId, code, name, taxTin, category, annualTax, deducted, gap, status, catchUpMonthsLeft, monthlyTds}] } (7C)
- `ait.certificate` {employeeId, month?, year?, fiscalYearId?} → full Section 86 TDS certificate payload (7D; month-scoped)
- `ait.myCertificates` {} → per-FY certificate summary for the logged-in employee (ESS)
- `ait.myCertificate.print` {fiscalYearId?, month?, year?} → own full certificate payload (ESS)
- `ait.logs.list` {source?} → immutable calculation audit journal (7F)

### Legacy (kept for backward compatibility — no UI)
- `taxRules.list` {} → legacy rule sets + slabs / `taxRules.save` {…} — pre-ITA-2023 fallback only; the active AitFiscalYear config always wins
- `ait.preview` {ruleSetId?, monthlyIncome, previousTaxDeducted?, manualAdjustment?} → legacy-signature wrapper around the new engine
- `taxExemptions.list|save|delete` — legacy exemption register (fallback path only)

## Loans / Advances / Expenses
- `loans.list` {status?, employeeId?} → [{employeeName, installments[{no,dueDate,amount,paidAmount,status}], nextDue}]
- `loans.create` {employeeId?, type, principal, installments, startDate, purpose?} (EMPLOYEE self-service ok)
- `loans.recordInstallment` {installmentId, amount?}
- `advances.list` {status?} / `advances.create` {employeeId?, amount, reason?, recoveryDate?, installments}
- `expenses.list` {status?, employeeId?} / `expenses.create` {employeeId?, category, title, amount, date, description?, projectRef?, receiptName?, receiptData?, paymentMethod?}

## Performance / KPI / Tasks
- `cycles.list|save` {id?, name, year, startDate, endDate, status}
- `reviews.list` {cycleId?, employeeId?} → [{ratings{area:1-5}, overallRating, employeeName, cycleName, status, managerComments…}]
- `reviews.save` {id?, cycleId, employeeId, reviewerId?, ratings{attendance,punctuality,productivity,quality,teamwork,communication,customerService,leadership,targetAchievement}, managerComments?, employeeComments?, strengths?, weaknesses?, goals?, improvementPlan?, status?}
- `reviews.finalize` {id}
- `kpiTemplates.list|save|delete` — items: [{name, target, unit, weight}] (weights must total 100)
- `kpiAssignments.list` {employeeId?, status?} → [{results:[{name,target,unit,weight,actual,achievementPct,score,rating}], templateName, employeeName}]
- `kpiAssignments.assign` {employeeId, templateId, periodLabel, dueDate?}
- `kpiAssignments.submitResults` {id, results: {itemName: actual}, status?}
- `tasks.list` {status?, assigneeId?, mine?, scope?} → [{assigneeName, checklist[{text,done}], comments[{userName,text,at}]}]
- `tasks.save` {id?, title, description?, assigneeId, scope?, priority?, startDate?, dueDate?, status?, progress?, checklist?}
- `tasks.comment` {taskId, text} / `tasks.delete` {id}

## Approvals / Notifications / Announcements / Calendar
- `approvals.queue` {status?="PENDING"} → [{id, processType, entityRef, stepName, canAct, thresholdSkip, amount, payload, actions[], createdAt}]
- `approvals.act` {requestId, decision: APPROVE|REJECT, comment?}
- `approvals.history` {status?}
- `notifications.list` {} / `notifications.read` {id?|all:true} / `notifications.unreadCount` {}
- `announcements.list` {} → [{audienceLabel, pinned, ...}] / `announcements.create` {title, body, audienceType: ALL|BRANCH|DEPARTMENT|DESIGNATION|SPECIFIC, audienceIds[], pinned?} / `announcements.delete` {id}
- `calendar.events` {month, year, kinds?[]} → [{date, kind, title, detail, color}] — kinds: BIRTHDAY ANNIVERSARY TASK LEAVE PENDING_LEAVE HOLIDAY PAYROLL DOC_EXPIRY CONTRACT_EXPIRY PROBATION LOAN_INSTALL EVENT REVIEW

## Letters (HR Documents)
- `templates.list` {type?} / `templates.save` {id?, type, name, subject, body (with {{employee_name}} etc.), signatoryName?, requiresApproval} / `templates.delete` {id}
- `templates.variables` {} → available variables list
- `letters.generate` {employeeId, type | templateId, effectiveDate?, reason?} → letter (DRAFT)
- `letters.list` {status?, type?, employeeId?} / `letters.submit` {id} → approval workflow / `letters.issue` {id, deliveryMethod: PORTAL|EMAIL|PRINT}
- `letters.download` {id} → { html, letterNumber } (print-ready)

## Exit
- `resignations.list` {status?} → [{employeeName, clearance, settlement, noticeMode, servedDays, actualLwd}]
- `resignations.submit` {employeeId?, resignationDate, proposedLwd, reason, remarks?, letterName?, letterData?}
- `resignations.withdraw` {id}
- `clearance.save` {id, checklist: [{department, items: [{item, cleared}]}]}
- `settlements.calculate` {resignationId, otherDeductions?} → { id, computation: {finalSalary, finalSalaryBasis{daysUptoLwd, monthWorkingDays, absentDays, dailyRate, grossProrated, absenceDeduction, alreadyPaidGross}, otAmount, otMinutes, leaveEncashment, bonusDue, bonusIds, gratuity, gratuityYears, gratuityEligible, noticePay, noticeBasis{requiredNoticeDays, servedDays, noticeStart}, pfSettlement, pfEmployeeShare, pfEmployerShare, loanDue, loanIds, advanceDue, advanceIds, noticeBuyout, gross, totalDeductions, netPayable} } — final salary on the payroll convention (working days 1→LWD minus absences, netted against payroll already paid; EXIT-005), OT on settings rates + monthly cap (EXIT-013), encashment minus pending reservations (EXIT-012)
- `settlements.approve` {id} / `settlements.pay` {id} — both refuse unless the exit clearance checklist is CLEARED, with the pending items named (EXIT-009). Pay closes the loan/advance ledgers (CLOSED / RECOVERED, EXIT-006), marks the consumed bonuses PAID (PAY-010), settles the PF balance (enrollment CLOSED + withdrawal ledger row + PF-Payable journal split, EXIT-007)

## ESS (self-service — EMPLOYEE role or any user with employeeId)
- `ess.profile` → { employee(+names), grossSalary, docs[], history[], banks[] }
- `ess.dashboard` → { attendance{present,late,absent,overtimeMinutes}, casualRemaining, openTasks, unreadNotifications, activeLoans, outstandingLoans, outstandingAdvances, pendingExpenses }
- `ess.attendance` {month?, year?} → { records[], summary{...}, today }
- `ess.leave` → { balances[], types[], requests[], substituteRequests[] }
- `ess.payroll` → { payslips[{entryId,payslipNumber,period,paidOn,gross,net,ait,breakdown}], totalAit }
- `ess.payroll.html` {entryId} → { html } — self-scoped payslip view/print for the caller's OWN payslip (PAY-007; payslips.html is manager-only)
- `ess.loans` → { loans[{installments}], advances }
- `ess.expenses` → claims [] / `ess.tasks` → tasks [] / `ess.performance` → { reviews, kpis }
- `ess.documents` → { docs[], letters[] } / `ess.resignation` → { resignation, clearance, settlement } | null
- `ess.wishes` → { wishes: [{name, message, kind}] }
- Self-service actions reuse: `leaveRequests.apply`, `expenses.create`, `loans.create`, `advances.create`, `attendance.selfCheckout`, `attendance.geofence.checkin`, `resignations.submit`, `attendance.corrections.request`, `tasks.comment`

## Reports / Analytics / Audit / Accounting
- `reports.<key>` {month?, year?, status?, employeeId?, branchId?, departmentId?…} → { columns: string[], rows: any[][], meta }
  keys: employees | attendance | leave | payroll | loans | expenses | performance
- `reports.<key>Csv` same payload → { csv } (string)
- `analytics.all` → { workforce{headcount[],turnover,avgTenureMonths,byBranch,byDepartment}, attendance{attTrend[]}, payroll{trend[],perEmployee,byBranch}, performance{topPerformers,kpiAchievement,avgRating}, cost{totalEmployeeCost,employerPct,expenseReimbursed} }
- `audit.list` {entity?, userId?, q?, from?, limit?} → AuditLog[]
- `journals.list` {refType?} → [{lines: [{account,accountName,debit,credit}], memo, amount, refType, date}]

## Status flows (display hints)
- PayrollRun: DRAFT → CALCULATED → HR_REVIEW → MANAGER_APPROVAL → ACCOUNTING_APPROVAL → APPROVED → PROCESSING → PAID (+ ADJUSTMENT runs; APPROVED/PAID immutable)
- LeaveRequest: PENDING → APPROVED | REJECTED | CANCELLED (substituteStatus: PENDING → ACCEPTED | DECLINED)
- Loan: PENDING → APPROVED(engine) → ACTIVE → CLOSED ; Advance: PENDING → RECOVERING → RECOVERED
- Expense: PENDING → REIMBURSED | REJECTED
- Resignation: SUBMITTED → … → NOTICE_PERIOD → COMPLETED (or REJECTED/WITHDRAWN)
- HrLetter: DRAFT → PREPARED → APPROVED → ISSUED (or REJECTED)

## Camera Manager (CCTV — Phase 6+)
- `camera.list` {brand?, branchId?, status?, includeDisabled?} → { cameras[], counts: {ONLINE,OFFLINE,UNKNOWN,total} } — perm: camera.view
- `camera.get` {id} → Camera (verificationCode stripped; hasVerificationCode: boolean) — perm: camera.view — 404 if cross-tenant
- `camera.create` {name, brand, serialNumber?, verificationCode?, channel?, branchId?, location?, installDate?} → Camera — perm: camera.create — 400 if EZVIZ/Imou + no camera.manage; 400 if unknown brand (registry-checked); 400 if pure-null (no serial AND no verificationCode); brand normalized to UPPERCASE
- `camera.update` {id, name?, model?, serialNumber?, channel?, verificationCode?, branchId?, location?, installDate?, status?} → Camera — perm: camera.edit (audit: camera.update — verb split) — 404 if cross-tenant or soft-deleted
- `camera.restore` {id} → Camera (enabled→true, lastError cleared) — perm: camera.edit (audit: camera.restore) — 404 if cross-tenant; idempotent if already enabled (no audit row on no-op)
- `camera.delete` {id} → Camera (enabled→false, soft-delete) — perm: camera.delete (auditStrict: camera.delete) — 404 if cross-tenant; idempotent if already disabled
- `camera.launch` {id} → { launchTarget: {kind:"DEEP_LINK"|`"QR_CODE"`|`"CLOUD_STREAM_TOKEN"`, ...}, fallbackWebUrl } — perm: camera.launch (auditStrict: camera.launch) — 404 if cross-tenant or soft-deleted; 429 if rate-limited (30/cam/min, 120/tenant/min)
- `camera.status` {id} → Camera (status, lastStatusCheckAt, lastSeenAt, lastError refreshed) — perm: camera.view — 404 if cross-tenant or soft-deleted; always sets lastStatusCheckAt=now() (Flag 1: "we tried" marker even for last-known providers like Hikvision/Dahua)
- `camera.credential.state` {} → {EZVIZ: boolean, IMOU: boolean} — perm: camera.manage — existence check via credentialExists (no decrypting)
- `camera.credential.upsert` {brand, appKey?, appSecret?, appId?} → {brand, encryptionKeyVersion, rotatedAt, createdAt} — perm: camera.manage — 400 if HIKVISION/DAHUA (per-camera, no tenant creds); 400 if EZVIZ without appKey+appSecret; 400 if IMOU without appId+appSecret; audit: camera.credential.create (first) or camera.credential.rotate (subsequent) via auditStrict; 429 if rate-limited (10/tenant/min)
- `camera.credential.delete` {brand} → {brand, deleted: true, affectedCameraCount: N} — perm: camera.manage — 404 if no creds for brand; audit: camera.credential.delete via auditStrict; 429 if rate-limited (10/tenant/min); affectedCameraCount = count of enabled cameras of that brand (for UI "N cameras will become unlaunchable" warning)

Error codes: 400 invalid payload/brand/credentials; 403 permission denied (camera.manage required for EZVIZ/Imou onboarding); 404 not found (cross-tenant, cross-branch, soft-deleted, or missing credential row); 429 rate-limited.

**11 routes total** (not 12 — the user's kickoff listed 12 as an estimate).

## Live Tracking & Secure Attendance (2026-10 round)

### Tracking (Live map — Attendance & Shifts → Live Tracking)
- `tracking.live` {branchId?,departmentId?,employeeId?,trackingStatus?,geoFenceId?} → { enabled, employees[{trackingStatus,batteryPercentage,gpsStatus,insideGeoFence,attendanceStatus,policySource,…}], kpis{totalAssigned,tracking,online,gpsDisabled,offline,lowBattery,outsideGeofence,suspicious} } — reads EmployeeTrackingState ONLY (never history); scope-aware (branch/department managers see their own scope)
- `tracking.history` {employeeId,from,to,page?,size?} → { points[], totalPoints, events[] } — paginated movement history for ONE employee/date range (§38)
- `tracking.start|stop` {id} → admin toggle per employee (tracking.manage; audited)
- `tracking.location` (MOBILE, self-scoped, rate-limited 240/10min) — see the mobile contract below
- `tracking.status` (MOBILE, self-scoped) — see the mobile contract below

### Geo-Fences (map-based configuration — Attendance & Shifts → Geo-Fence)
- `geofences.list` {} → { fences[], branchDefaults[] } (migrated branch fences are flagged `migratedFromBranch`)
- `geofences.save` {id?,name,branchId?,type:"CIRCLE",latitude,longitude,radiusM,startTime?,endTime?,active?} (geofence.create|edit; audited)
- `geofences.setEnabled` {id,active} (audited)
- `geofences.delete` {id, confirm:"DELETE"} (geofence.delete; audited)

### Attendance Policies (dynamic engine — Attendance & Shifts → Policies & Check-In)
- `attendance.policy.list` {} → policies with assignments + fences (attendance.view)
- `attendance.policy.save` {id?,name,policyType,priority?,startDate?,endDate?,startTime?,endTime?,daysOfWeek[],timezone?,active?,config{…typed per type…},assignments[{scopeType,scopeId?}],geoFenceIds[]} (attendance.edit; typed config validated per policyType; audited)
- `attendance.policy.delete` {id, confirm:"DELETE"} (attendance.delete; audited)
- `attendance.policy.effective` {employeeId,policyType?} → per-type effective policy + SOURCE (Employee/Department/Branch/Global) + inSchedule — the UI "Effective Policy" inspector (§6)
- Policy types & configs:
  - `TRACKING` {updateIntervalSec,maxAccuracyM,lowBatteryThreshold,criticalBatteryThreshold,offlineAfterMinutes,suspiciousAction:ALLOW|WARN|REVIEW|REJECT}
  - `MANDATORY_GPS` {graceMinutes}
  - `MULTIPLE_CHECKIN` {minIntervalMinutes,maxPerDay,methods[]}
  - `ATTENDANCE_METHOD` {methods[],selfieRequired,requireGeofence}

### Attendance Events / History / Security (§35, §25)
- `attendance.events.list` {from?,to?,employeeId?,branchId?,departmentId?,eventType?,attendanceMethod?,status?,locationIntegrityStatus?,gpsStatus?,geoFenceId?,reviewStatus?,page?,size?} → {events[],total} (attendance.view; scope-aware)
- `attendance.events.get` {id} → event + pending review count (attendance.view)
- `attendance.events.review` {id,decision:APPROVE|REJECT,reason?} → admin review decision on suspicious events (attendance.verify; audited; REJECT notifies the employee)
- `attendance.selfie.view` {id} → { dataUrl, mimeType, fileHash, capturedAt, byteSize } (attendance.download; STRICT-audited — every view is recorded §26)

### Extended geo-fence attendance (§22–§28)
- `attendance.geofence.checkin|checkout` now ALSO accept the mobile payload (selfieDataUrl, batteryPercentage, gpsStatus, networkStatus, clientTimestamp, clientEventId, deviceId, isMockLocation, mobileSessionId). Server-side pipeline: effective fences (policy-linked, legacy branch fallback) → server-computed distance → accuracy rules (§23) → location integrity (§24) → method policy (§28) → Attendance summary + immutable AttendanceEvent + optional private selfie proof.
- `attendance.selfie.checkin` {selfieDataUrl (REQUIRED), latitude?, longitude?, accuracyM?, deviceInfo?, batteryPercentage?, gpsStatus?, networkStatus?, clientTimestamp?, clientEventId?, deviceId?, mobileSessionId?, isMockLocation?, reason?} -> Attendance summary + { distance?, fence?, integrity? } - selfie check-in with best-effort GPS (coordinates optional: selfie-without-GPS resolves method SELFIE, selfie-with-GPS resolves GEOFENCE_SELFIE). Requires the effective ATTENDANCE_METHOD policy to list SELFIE (or GEOFENCE_SELFIE); 403 otherwise. When requireGeofence is on, GPS + fence validation are mandatory (fence REVIEW verdicts leave a REVIEW_REQUIRED event trail, M-15); otherwise fence failure/absence never blocks the punch. Same guarantees as the geo routes: identity from the session (never payload), M-14 selfie throttle, byte-sniffed private proof storage (sec 26), H-4 first-in guard, location integrity (sec 24), immutable AttendanceEvent + audit row.
- `attendance.periodicCheck` (MOBILE, self-scoped, rate-limited 40/10min) — see the mobile contract below
- `attendance.multipleCheckin.validate` (MOBILE, self-scoped) — see the mobile contract below

## Salary Payout & Dynamic Salary Export (2026-10 round)

### Payout settings & validation (§42–§47)
- Settings groups: `settings.save {group:"payout", values:{bankEnabled,cashEnabled,mfsEnabled,maxCashMfsSalary,thresholdBasis}}` (Payroll → Payout Settings)
- `payroll.payout.validate` {employeeId?|method?,salary?} → { ok, method, reasons[], warnings[], settings } — same engine the enforcement points use
- `payroll.payout.status` {runId} → { rows[{code,name,method,net,ok,reasons}], summary{total,compliant,blocked} } — per-run pre-flight (§78)
- Enforcement points (server-side, NEVER frontend-only §45): employees.createWithStructure + employees.update (payoutMethod rides along), payroll.pay pre-flight (first violation blocks payment with the specific employee + reason), salary export (true method re-resolved per employee §77). Payslips resolve the DESIGNATED payout account (exactly-one semantics, no findFirst guessing §47).
- Employee payload fields: `payoutMethod` (BANK|CASH|MFS) + `payoutBank,payoutBranch,payoutAccountName,payoutAccountNumber,payoutRoutingNumber` (BANK) or `payoutMfsProvider,payoutMfsNumber` (MFS). Blank account fields on UPDATE keep stored values (merge semantics).

### Salary export (§48–§54)
- `payroll.export.salary` {runId,type:ALL|BANK|CASH|MFS,format:xlsx|csv|pdf,branchId?,departmentId?,employeeId?} → { filename, csv? | base64?, totals{employees,gross,ot,bonus,deductions,ait,net}, skipped[{employeeId,reason}] } (payroll.export; BANK additionally requires bankInfo.view §50; every export audited with run+type+filters+count+format)
- `payroll.export.preview` {runId,type,filters…} → { totals, payoutRecipients, skipped, runLabel } — preview before generating (§76)
- Server-side truth: the export engine re-resolves every employee's actual payout method — a client "type=BANK" never fabricates bank rows (§77)

## Mobile client contract (2026-10 round §12–§13, §63–§66)

The native Android client (not part of this repository) integrates through the SAME `/api/hrm` RPC endpoint with `Authorization: Bearer <token>` (the existing auth architecture — §13). The employee identity ALWAYS derives from the authenticated session; employeeId/branchId/departmentId/policyId/geoFence validity/distance from the payload are NEVER trusted (§86).

- `tracking.status` {} → { trackingEnabled, intervalSec, policySource, mandatoryGps{active,graceMinutes}, attendanceMethods{methods[],selfieRequired,requireGeofence}, batteryThresholds, serverTime } — poll after boot/focus to learn what to do
- `tracking.location` { latitude, longitude, accuracyM?, batteryPercentage?, isCharging?, gpsStatus?, networkStatus?, clientTimestamp?, clientEventId?, isMockLocation?, deviceId?, trackingSessionId? } → { ok, duplicate, trackingStatus, intervalSec, integrity{status,decision} } — high-frequency ingestion; idempotent on (vendor, clientEventId) — retries NEVER duplicate (§65); rate-limited 240/10min (§66)
- `attendance.periodicCheck` { latitude?, longitude?, accuracyM?, selfieDataUrl?, batteryPercentage?, clientTimestamp?, clientEventId?, deviceId?, … } → { ok, duplicate, eventId, status, nextCheckAt, remainingToday } — interval/limit/schedule enforced server-side (§29–§32)
- `attendance.multipleCheckin.validate` {} → { allowed, reason?, nextCheckAt?, intervalMinutes, remainingToday, allowedMethods[] } — UX dry-run
- `attendance.geofence.checkin|checkout` — extended payload per above
- Offline queue: capture locally, upload on reconnect with the ORIGINAL clientTimestamp + clientEventId — the server validates timestamp freshness, integrity and duplicates; offline events are never blindly trusted (§32)
- Background tracking requires the native client (§12): browser geolocation is foreground-only and is NOT treated as background tracking

## Selfie Attendance Gaps Round (G1–G4, 2026-10-03)

Closes the remaining gaps against the Rysenova selfie-attendance reference: in-app capture provenance (G1), employee↔device enrollment (G2), explicit versioned consent (G3) and the exportable attendance-event report (G4). All routes ride the existing `/api/hrm` RPC contract; employee identity always derives from the session.

### G1 — in-app capture + quality provenance
- The ESS portal captures selfies through the in-app camera dialog (`SelfieCaptureDialog`): live `getUserMedia` preview with framing ellipse + guidance ("no face detected / too dark / move closer"), auto-downscale to ≤640px JPEG, and a FILE_PICKER fallback for devices without a camera (secure-context gate included). The punch payload adds `selfieQuality: {score, method, faceDetected, faceRatio, brightness, sharpness, width, height, bytesApprox}` — EVIDENCE METADATA ONLY: shown to reviewers as context, never flips `verificationStatus` (§27).
- `attendance.selfie.checkin` and `attendance.geofence.checkin` accept the optional `selfieQuality` object; it is stored on `AttendanceProof.qualityJson` (default `{}` for legacy proofs).
- `tracking.status` no-policy fallback is now permissive (legacy parity with `enforceMethodPolicy`): `{methods:["GEOFENCE","SELFIE","GEOFENCE_SELFIE","DEVICE_PUNCH"], selfieRequired:false, requireGeofence:false}` — the portal's selfie buttons work out of the box; a vendor who wants to forbid selfie punches creates an ATTENDANCE_METHOD policy without SELFIE (the ESS then hides the buttons and the routes 403 with an actionable message). `attendance.selfie.checkin` likewise allows punches when NO method policy exists (method = GEOFENCE_SELFIE with GPS, SELFIE without).
- New ESS quick actions: **Selfie + Geo Check-In** (reliable GPS + mandatory selfie → `attendance.selfie.checkin` with coordinates → GEOFENCE_SELFIE) alongside the existing Geo Check-In and Selfie Check-In. Visibility toggles: Settings → Self-Service Portal (`essPortal.showSelfieGeoCheckIn`, default ON; the group also gained a save-safe whitelist — H-2 style single registry).

### G2 — device binding (employee ↔ device enrollment)
- `attendance.myDevices.enroll` {deviceId (client-generated stable id, 8–120 chars), label?, platform:ANDROID|IOS|WEB|UNKNOWN?, userAgent?} → {id, status:PENDING, enrollKey, message} — self-scoped (session identity). The enrolment key is server-issued (CSPRNG) and shown ONCE; the stored `keyHash` is sha-256 (a cloned deviceId alone cannot impersonate the phone). Cap: 3 ACTIVE/PENDING devices — the 4th enrolment auto-revokes the oldest. Audited.
- `attendance.myDevices.list` {} → {devices[{id,deviceId,label,platform,status,enrolledAt,approvedAt,lastSeenAt,revokedAt,revokeReason}]} — self-scoped; returns `{devices:[]}` when the caller has no linked employee profile.
- `attendance.myDevices.remove` {id} → {removed:true} — soft-revoke by the employee themselves (status REVOKED, reason "Removed by employee"). Audited.
- `attendance.employeeDevices.list` {employeeId} → {devices[]} (attendance.edit; scope-checked via assertEmployeeVisible)
- `attendance.employeeDevices.decide` {id, decision:APPROVE|REVOKE, reason?} → {id,status} (attendance.edit; audited; APPROVE only valid on PENDING rows; REVOKE stamps revokedAt/By/Reason)
- Enforcement is policy-driven (`ATTENDANCE_METHOD` config `deviceBinding`): OFF (record only) | ADVISORY (punch lands flagged DEVICE_MISMATCH for review) | STRICT (403 unless the device is ACTIVE). Punch routes stamp `lastSeenAt`/`lastSeenIp` on every enrolled deviceId.

### G3 — explicit selfie consent (Privacy & Consent Controls)
- Settings group `selfieConsent` {enabled, version, text} (Settings → Attendance → Selfie Consent) — OFF by default; vendors opt in and write their own text.
- `attendance.consent.status` {} → {enabled, accepted, version, text, acceptedAt} — self-scoped; `{enabled:false,accepted:false}` when the vendor has not enabled consent or the caller has no employee profile.
- `attendance.consent.accept` {version?, userAgent?} → upserts an `EmployeeConsent` row {purpose:SELFIE_ATTENDANCE, version, textHash (sha-256 of the exact shown text — later policy edits cannot retro-fit consent), acceptedAt, source:ESS_PORTAL, ip, userAgent}. Audited.
- Consent NEVER blocks a punch (§27): a missing acknowledgment is surfaced in the ESS (banner) and in the punch response for HR follow-up. Re-consent on a new version = a NEW row; prior agreements stay provable.

### G4 — attendance-event export
- `attendance.events.export` {from?,to?,employeeId?,branchId?,departmentId?,eventType?,attendanceMethod?,status?,locationIntegrityStatus?,gpsStatus?,geoFenceId?,reviewStatus?,format:xlsx|csv} → {filename, base64?|csv?, count, generatedAt} (attendance.export; same filter set as `attendance.events.list`, no paging — 10,000-row cap; xlsx via the same SheetJS build as payroll.export.salary, csv hand-rolled). Every export is audited with the filter set + row count.
- Deliberately mirrors the payroll export family (§48–§54): server-side truth, permission-gated, audited, XLSX/CSV only (PDF omitted — tabular data, no letterhead semantics).

## Field Force (Wave 2 WP-M + 2026-10-13 History/Hit Map)

- `fieldforce.locations.list` {includeInactive?} → {locations} (fieldforce.view)
- `fieldforce.locations.save` {id?, name, address?, lat, lng, radiusM(10–5000), contactName?, contactPhone?, note?, active?} → VisitLocation row (fieldforce.edit; duplicate-name guard; audited)
- `fieldforce.locations.delete` {id} → {ok} (fieldforce.delete; soft delete)
- `fieldforce.geo.search` {q(3–200)} → {results:[{label,lat,lng}]} (fieldforce.view; server-side Nominatim proxy, 6 s timeout, 10-min memo cache)
- `fieldforce.plan.get` {date, employeeId?} → {plan, items+visit, visits} (fieldforce.view; visibility-scoped)
- `fieldforce.plan.save` {employeeId, date, note?, items[{id?, locationId, plannedFrom?, plannedTo?, tasks?}]≤50} → {ok, plan} (fieldforce.edit; upsert + item diff-sync; inverted windows 400)
- `fieldforce.plan.delete` {id} → {ok} (fieldforce.delete)
- `fieldforce.visit.checkin` / `fieldforce.visit.checkout` — self-scoped ESS actions (GPS distance computed server-side; out-of-radius rule per the route header)
- `fieldforce.myday` {} → today's plan + open visit + locations (self-scoped)
- `fieldforce.board` {date} → per-employee day cards (fieldforce.view; visibility-scoped)
- `fieldforce.report` {from, to, employeeId?} → compliance summary + per-employee rows (fieldforce.view; ≤366 days)
- `fieldforce.history` {from, to, employeeId?} → {rows, summary} — **one row per (employee, business date)**: planned/completed/missed/ad-hoc counts, GPS ping count (one grouped SQL query bucketed in the deployment zone), last activity. ≤366 days, ≤500 rows. (fieldforce.view; visibility-scoped)
- `fieldforce.hitmap` {employeeId, date} → {employee, date, planned[], visits[], track[] (≤600 sampled points + trackStride + totalPings), trackKm, stops[] (derived stationary clusters ≥3 min, minus visit overlaps), summary} — the Location Hit Map dataset. (fieldforce.view; assertEmployeeVisible — cross-tenant ids 404)
- Derived stoppages: `detectTrackStoppages(points, {anchorRadiusM=75, minDurationSec=180})` exported from src/hrm-server/routes/fieldforce.ts for unit tests.

## Security & privacy surfaces (Wave R3-3, 2026-10-17)

**Job Center**
- `jobs.get` {id} — R3-3/SUB-103: no longer public (unauthenticated → 401, was a 500); requires `jobs.view`. The `result` payload is REDACTED (`result: null, resultRedacted: true, resultPermRequired: "<module>.<action>"`) for job types whose resultJson carries bulk sensitive data: SALARY_EXPORT → `payroll.view`, BACKUP_EXPORT / BACKUP_PG_DUMP / RESTORE_DRILL → `settings.edit`. Status/progress/counts always flow.

**Approval delegation**
- `delegations.save|end` — R3-3/RBAC-101: now gated on `approvals.view` (self-scope preserved: non-admins delegate only their own authority; an ESS account can no longer call it at all). Concurrent ACTIVE delegations per delegator capped at 10.

**AI Assist**
- `ai.reportAsk` {question} — R3-3/AI-001: additionally requires `reports.view`; report rendering now runs AS THE CALLER (`renderReportAsCaller`) so branch/department scope filters apply (a branch manager's question returns only their branch's rows). The synthetic HR_ADMIN render context is reserved for the SYSTEM scheduler.
- `ai.settings.get` — now `ai.view` (was ai.generate).
- `ai.settings.save` — now `settings.edit` (was ai.generate — any AI-enabled user could repoint the outbound LLM endpoint; AI-002).

**Reports (PII gates)**
- `reports.employeesBiodataCsv` — HIGH-11 unchanged server-side (`reports.pii` perm + `payload.confirm === "EXPORT"`); the Reports view now renders the typed-confirmation dialog that sends it (RPT-002), and the client-side .xlsx export item is hidden for PII-class reports when the caller lacks `reports.pii`.
- `reports.templates.save` — RPT-001: a PII-class `reportKey` (currently `employeesBiodata`) additionally requires the `reports.pii` permission, and every recipient must be a tenant member (a user login or an employee e-mail address) — external addresses are refused with the offending address named. The scheduler re-verifies membership at RUN time (a departed member's template is SKIPPED, never SENT).

**Audit retention**
- `auditRetention.purge` — RDM-001: `{ confirm: "PURGE", reason }` (typed confirmation + reason ≥ 10 chars, zod-enforced); restricted to the VENDOR_OWNER role; the effective retention window is `max(settings days, 365)` — a shortened setting can never delete younger rows; audit rows for money-related actions (payroll/payout/settlement/loans/advances/bonus/commissions/accounting/backups/auditRetention) are exempt from every purge.

**Public REST API v1 (`/api/v1/*`)** — SUB-101/SUB-102
- Every key-authenticated request now resolves the tenant's subscription entitlements in `authenticateApiKey()`:
  - plan without `apiAccess` → `403 { code: "API_NOT_INCLUDED" }` (upgrade required);
  - EXPIRED/SUSPENDED/CANCELLED tenant + a `*:write` scope → `423 { code: "SUBSCRIPTION_READONLY" }` (read scopes keep working — the workspace is read-only, not bricked);
  - LEGACY tenants (no subscription row) pass both gates.
- The `integrations` module (API keys + webhooks administration) is now plan-gated by the API feature flag (`MODULE_FEATURE_GATES.integrations = "API"`) and is per-tenant overridable from the SaaS Owner Console (`TENANT_MODULES` entry added).

**Permission vocabulary (types.ts)** — new verbs `reveal`, `pii`; new module `users`. Role templates: HR_ADMIN/VENDOR_OWNER gain `users.view/create/edit/delete`, `reports.pii`, `employeeDocs.reveal`; HR_MANAGER gains `employeeDocs.reveal` + read-only `users.view`; BRANCH_MANAGER/DEPT_MANAGER/EMPLOYEE see masked identity numbers and no salary structure on the wire (server-side projection, see employees.get above).
