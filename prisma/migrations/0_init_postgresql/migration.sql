-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "legalName" TEXT,
    "logoUrl" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "signatoryName" TEXT,
    "signatoryDesignation" TEXT,
    "signatureUrl" TEXT,
    "sealUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT NOT NULL,
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "branchId" TEXT,
    "departmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "passwordHistory" TEXT NOT NULL DEFAULT '[]',
    "mfaEnrolled" BOOLEAN NOT NULL DEFAULT false,
    "passwordResetToken" TEXT,
    "passwordResetExpiresAt" TIMESTAMP(3),
    "passwordResetRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL DEFAULT 'FULL',
    "csrfToken" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMfaSecret" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "recoveryCodesHash" TEXT NOT NULL DEFAULT '[]',
    "lastUsedCounter" INTEGER,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMfaSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "mfaRequired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "ip" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT,
    "employeeId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEvent" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" TEXT,
    "description" TEXT,
    "branchId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalWorkflow" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "processType" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "approverRole" TEXT,
    "approverUserId" TEXT,
    "departmentScope" BOOLEAN NOT NULL DEFAULT false,
    "branchScope" BOOLEAN NOT NULL DEFAULT false,
    "amountThreshold" DOUBLE PRECISION,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "allowDelegation" BOOLEAN NOT NULL DEFAULT false,
    "rejectBehavior" TEXT NOT NULL DEFAULT 'REJECT_ALL',

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "processType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityRef" TEXT,
    "requestedBy" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalAction" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrSetting" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PUBLIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'STORE',
    "address" TEXT,
    "managerId" TEXT,
    "contact" TEXT,
    "operatingHours" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geofenceRadius" DOUBLE PRECISION,
    "geofenceActive" BOOLEAN NOT NULL DEFAULT false,
    "geofenceStartTime" TEXT,
    "geofenceEndTime" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameBn" TEXT,
    "description" TEXT,
    "branchId" TEXT,
    "headId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Designation" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameBn" TEXT,
    "departmentId" TEXT,
    "grade" TEXT,
    "minSalary" DOUBLE PRECISION,
    "maxSalary" DOUBLE PRECISION,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Designation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'FIXED',
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "graceMinutes" INTEGER NOT NULL DEFAULT 10,
    "breakMinutes" INTEGER NOT NULL DEFAULT 60,
    "minWorkingHours" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "otThresholdMinutes" INTEGER NOT NULL DEFAULT 30,
    "otMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "otHolidayMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "otWeeklyOffMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "weeklyOff" TEXT NOT NULL DEFAULT 'FRIDAY',
    "branchId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "photoUrl" TEXT,
    "photoThumb" TEXT,
    "fullName" TEXT NOT NULL,
    "nameBn" TEXT,
    "preferredName" TEXT,
    "fatherName" TEXT,
    "motherName" TEXT,
    "spouseName" TEXT,
    "dob" TEXT,
    "placeOfBirth" TEXT,
    "gender" TEXT,
    "bloodGroup" TEXT,
    "maritalStatus" TEXT,
    "nationality" TEXT NOT NULL DEFAULT 'Bangladeshi',
    "religion" TEXT,
    "mobile" TEXT,
    "altMobile" TEXT,
    "personalEmail" TEXT,
    "officialEmail" TEXT,
    "emergencyName" TEXT,
    "emergencyRelation" TEXT,
    "emergencyMobile" TEXT,
    "presentAddress" TEXT,
    "permanentAddress" TEXT,
    "division" TEXT,
    "district" TEXT,
    "city" TEXT,
    "postCode" TEXT,
    "addressSame" BOOLEAN NOT NULL DEFAULT false,
    "branchId" TEXT,
    "departmentId" TEXT,
    "designationId" TEXT,
    "reportingManagerId" TEXT,
    "hrManagerId" TEXT,
    "supervisorId" TEXT,
    "workLocation" TEXT,
    "joiningDate" TEXT,
    "confirmationDate" TEXT,
    "probationMonths" INTEGER NOT NULL DEFAULT 3,
    "employmentType" TEXT NOT NULL DEFAULT 'PERMANENT',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "category" TEXT,
    "grade" TEXT,
    "shiftId" TEXT,
    "weeklyOff" TEXT,
    "contractStart" TEXT,
    "contractEnd" TEXT,
    "otEligible" BOOLEAN NOT NULL DEFAULT true,
    "previousEmployerIncome" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAlreadyDeducted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxTin" TEXT,
    "taxCategory" TEXT,
    "declaredInvestment" DOUBLE PRECISION,
    "festivalBonusOverride" DOUBLE PRECISION,
    "annualGrossOverride" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyMember" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "dob" TEXT,
    "gender" TEXT,
    "occupation" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "address" TEXT,
    "dependent" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "FamilyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Education" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "degree" TEXT NOT NULL,
    "examination" TEXT,
    "institution" TEXT,
    "board" TEXT,
    "major" TEXT,
    "passingYear" TEXT,
    "result" TEXT,
    "certificateName" TEXT,
    "certificateData" TEXT,
    "notes" TEXT,

    CONSTRAINT "Education_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referee" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT,
    "organization" TEXT,
    "designation" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "address" TEXT,
    "knownFor" TEXT,
    "type" TEXT NOT NULL DEFAULT 'PROFESSIONAL',
    "notes" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,

    CONSTRAINT "Referee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreviousEmployment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "designation" TEXT,
    "department" TEXT,
    "joinDate" TEXT,
    "leaveDate" TEXT,
    "lastSalary" DOUBLE PRECISION,
    "reasonForLeaving" TEXT,
    "supervisor" TEXT,
    "contact" TEXT,
    "notes" TEXT,

    CONSTRAINT "PreviousEmployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "holderName" TEXT,
    "bank" TEXT,
    "branch" TEXT,
    "accountNumber" TEXT,
    "routingNumber" TEXT,
    "accountType" TEXT NOT NULL DEFAULT 'SALARY',
    "mfsProvider" TEXT,
    "mfsNumber" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'BANK',
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'IDENTITY',
    "docType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "docNumber" TEXT,
    "nameOnDoc" TEXT,
    "issueDate" TEXT,
    "expiryDate" TEXT,
    "issuingAuthority" TEXT,
    "status" TEXT NOT NULL DEFAULT 'VALID',
    "fileName" TEXT,
    "fileData" TEXT,
    "notes" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeHistory" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "effectiveDate" TEXT,
    "amount" DOUBLE PRECISION,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "oldDesignationId" TEXT,
    "newDesignationId" TEXT,
    "oldDepartmentId" TEXT,
    "newDepartmentId" TEXT,
    "oldGrade" TEXT,
    "newGrade" TEXT,
    "newBasicSalary" DOUBLE PRECISION,
    "effectiveDate" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromBranchId" TEXT,
    "toBranchId" TEXT,
    "fromDepartmentId" TEXT,
    "toDepartmentId" TEXT,
    "fromDesignationId" TEXT,
    "toDesignationId" TEXT,
    "fromManagerId" TEXT,
    "toManagerId" TEXT,
    "fromShiftId" TEXT,
    "toShiftId" TEXT,
    "workLocation" TEXT,
    "effectiveDate" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryRevision" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "previousSalary" DOUBLE PRECISION NOT NULL,
    "newSalary" DOUBLE PRECISION NOT NULL,
    "increaseAmount" DOUBLE PRECISION NOT NULL,
    "increasePercent" DOUBLE PRECISION NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "reason" TEXT,
    "type" TEXT NOT NULL DEFAULT 'INCREMENT',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "shiftId" TEXT,
    "checkIn" TEXT,
    "checkOut" TEXT,
    "workingMinutes" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ABSENT',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "otApproved" BOOLEAN,
    "deviceInfo" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "ip" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceDevice" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "syncStatus" TEXT NOT NULL DEFAULT 'IDLE',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "serialNumber" TEXT,
    "deviceIdentifier" TEXT,
    "protocol" TEXT NOT NULL DEFAULT 'ADMS',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ipAddress" TEXT,
    "port" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "firmwareVersion" TEXT,
    "pushVersion" TEXT,
    "commKey" TEXT,
    "commKeyHash" TEXT,
    "commKeySalt" TEXT,
    "commKeySetAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastAttendanceAt" TIMESTAMP(3),
    "clockDriftSec" INTEGER,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "configuration" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceDeviceUser" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceUserId" TEXT NOT NULL,
    "enrollmentStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceDeviceUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRawEvent" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceSerial" TEXT NOT NULL,
    "deviceUserId" TEXT NOT NULL,
    "employeeId" TEXT,
    "eventTime" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifyMode" INTEGER,
    "attendanceStatus" INTEGER,
    "workCode" TEXT,
    "eventType" TEXT NOT NULL,
    "rawLine" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
    "processingError" TEXT,
    "processedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceRawEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCommLog" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "deviceId" TEXT,
    "serial" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "correlationId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceCommLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCommand" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "result" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCorrection" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "requestedIn" TEXT,
    "requestedOut" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "actedBy" TEXT,
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrToken" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "checkOutAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QrToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "defaultDays" INTEGER NOT NULL DEFAULT 10,
    "carryForward" BOOLEAN NOT NULL DEFAULT false,
    "maxCarryForward" INTEGER NOT NULL DEFAULT 0,
    "carryForwardExpiryMonths" INTEGER NOT NULL DEFAULT 3,
    "accrualFrequency" TEXT NOT NULL DEFAULT 'ANNUAL',
    "encashmentAllowed" BOOLEAN NOT NULL DEFAULT false,
    "encashmentRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "encashmentCap" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "waitingPeriodDays" INTEGER NOT NULL DEFAULT 0,
    "probationEligible" BOOLEAN NOT NULL DEFAULT false,
    "requiresAttachment" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveBalance" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "entitled" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "used" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pending" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carriedForward" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "days" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "halfDay" BOOLEAN NOT NULL DEFAULT false,
    "attachmentName" TEXT,
    "attachmentData" TEXT,
    "substituteEmployeeId" TEXT,
    "substituteStatus" TEXT,
    "substituteComment" TEXT,
    "contactNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvalRequestId" TEXT,
    "actedBy" TEXT,
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryStructure" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "basic" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "houseRent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "medical" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conveyance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "food" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mobileAllow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "internetAllow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "attendanceAllow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherAllowance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gross" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "basicPaisa" INTEGER,
    "houseRentPaisa" INTEGER,
    "medicalPaisa" INTEGER,
    "conveyancePaisa" INTEGER,
    "foodPaisa" INTEGER,
    "mobileAllowPaisa" INTEGER,
    "internetAllowPaisa" INTEGER,
    "attendanceAllowPaisa" INTEGER,
    "otherAllowancePaisa" INTEGER,
    "grossPaisa" INTEGER,
    "componentsJson" TEXT NOT NULL DEFAULT '[]',
    "revisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodWeek" INTEGER NOT NULL DEFAULT 0,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "runType" TEXT NOT NULL DEFAULT 'REGULAR',
    "adjustRunId" TEXT,
    "adjustSeq" INTEGER NOT NULL DEFAULT 0,
    "cutoffDate" TEXT,
    "processedDate" TEXT,
    "paymentDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalGross" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalOt" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalBonus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalNet" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalGrossPaisa" INTEGER,
    "totalOtPaisa" INTEGER,
    "totalBonusPaisa" INTEGER,
    "totalDeductionPaisa" INTEGER,
    "totalAitPaisa" INTEGER,
    "totalNetPaisa" INTEGER,
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "approvalRequestId" TEXT,
    "journalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollEntry" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "structureId" TEXT,
    "presentDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "absentDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "otMinutes" INTEGER NOT NULL DEFAULT 0,
    "leaveDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gross" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "absenceDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lateDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loanDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "advanceDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ait" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossPaisa" INTEGER,
    "otAmountPaisa" INTEGER,
    "bonusPaisa" INTEGER,
    "commissionPaisa" INTEGER,
    "absenceDeductionPaisa" INTEGER,
    "lateDeductionPaisa" INTEGER,
    "loanDeductionPaisa" INTEGER,
    "advanceDeductionPaisa" INTEGER,
    "otherDeductionPaisa" INTEGER,
    "aitPaisa" INTEGER,
    "netPaisa" INTEGER,
    "breakdownJson" TEXT NOT NULL DEFAULT '{}',
    "taxRuleSetId" TEXT,
    "payslipNumber" TEXT,
    "emailStatus" TEXT,
    "status" TEXT NOT NULL DEFAULT 'INCLUDED',
    "adjustEntryId" TEXT,
    "journalId" TEXT,

    CONSTRAINT "PayrollEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRuleSet" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'SLAB',
    "directAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxableBase" TEXT NOT NULL DEFAULT 'GROSS',
    "taxFreeThreshold" DOUBLE PRECISION NOT NULL DEFAULT 350000,
    "rebatePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "effectiveFrom" TEXT,
    "notes" TEXT,
    "source" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxRuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxSlab" (
    "id" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "minIncome" DOUBLE PRECISION NOT NULL,
    "maxIncome" DOUBLE PRECISION,
    "rate" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "TaxSlab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxExemption" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'REBATE',
    "maxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxExemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryTemplate" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "basic" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "houseRent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "medical" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conveyance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "food" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mobileAllow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "internetAllow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "attendanceAllow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherAllowance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "componentsJson" TEXT NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bonus" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "calcType" TEXT NOT NULL DEFAULT 'FIXED',
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percent" DOUBLE PRECISION,
    "baseAmount" DOUBLE PRECISION,
    "formula" TEXT,
    "periodMonth" INTEGER,
    "periodYear" INTEGER,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "runId" TEXT,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bonus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deduction" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PERSONAL',
    "principal" DOUBLE PRECISION NOT NULL,
    "interestRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "installmentAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outstanding" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "purpose" TEXT,
    "guarantorId" TEXT,
    "guarantorStatus" TEXT,
    "guarantorRespondedAt" TIMESTAMP(3),
    "guarantorNote" TEXT,
    "journalDisburseId" TEXT,
    "approvalRequestId" TEXT,
    "approvedBy" TEXT,
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanInstallment" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "no" INTEGER NOT NULL,
    "dueDate" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payrollEntryId" TEXT,
    "paidAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "LoanInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Advance" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "requestDate" TEXT NOT NULL,
    "recoveryDate" TEXT,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "deducted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outstanding" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvalRequestId" TEXT,
    "approvedBy" TEXT,
    "actedAt" TIMESTAMP(3),
    "journalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Advance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseClaim" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "approvedAmount" DOUBLE PRECISION,
    "date" TEXT NOT NULL,
    "description" TEXT,
    "branchId" TEXT,
    "projectRef" TEXT,
    "receiptName" TEXT,
    "receiptData" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'BANK',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reimbursementDate" TEXT,
    "approvalRequestId" TEXT,
    "approvedBy" TEXT,
    "actedAt" TIMESTAMP(3),
    "journalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountJournal" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT,
    "idempotencyKey" TEXT,
    "date" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "linesJson" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'HRM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewCycle" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReview" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "ratingsJson" TEXT NOT NULL DEFAULT '{}',
    "overallRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "managerComments" TEXT,
    "employeeComments" TEXT,
    "strengths" TEXT,
    "weaknesses" TEXT,
    "goals" TEXT,
    "improvementPlan" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiTemplate" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designationId" TEXT,
    "departmentId" TEXT,
    "itemsJson" TEXT NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiAssignment" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "templateId" TEXT,
    "periodLabel" TEXT NOT NULL,
    "dueDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resultsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigneeId" TEXT NOT NULL,
    "departmentId" TEXT,
    "branchId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'EMPLOYEE',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "startDate" TEXT,
    "dueDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'TODO',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "checklistJson" TEXT NOT NULL DEFAULT '[]',
    "attachmentName" TEXT,
    "commentsJson" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterTemplate" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "signatoryName" TEXT,
    "signatoryDesignation" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LetterTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrLetter" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "templateId" TEXT,
    "letterNumber" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "signatoryName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "deliveryMethod" TEXT,
    "emailStatus" TEXT,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "approvalRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resignation" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "submissionDate" TEXT NOT NULL,
    "resignationDate" TEXT NOT NULL,
    "proposedLwd" TEXT NOT NULL,
    "actualLwd" TEXT,
    "reason" TEXT NOT NULL,
    "remarks" TEXT,
    "letterName" TEXT,
    "letterData" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "acceptedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawStage" TEXT,
    "noticeMode" TEXT NOT NULL DEFAULT 'FULL',
    "noticeDays" INTEGER NOT NULL DEFAULT 30,
    "servedDays" INTEGER NOT NULL DEFAULT 0,
    "approvalRequestId" TEXT,
    "actedBy" TEXT,
    "actedAt" TIMESTAMP(3),
    "closureStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "closureDoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resignation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'PERCENT_OF_SALES',
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cap" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "branchId" TEXT,
    "designationId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExitClearance" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "resignationId" TEXT NOT NULL,
    "checklistJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "clearedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExitClearance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinalSettlement" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "resignationId" TEXT NOT NULL,
    "computationJson" TEXT NOT NULL DEFAULT '{}',
    "netPayable" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "journalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinalSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audienceType" TEXT NOT NULL DEFAULT 'ALL',
    "audienceIds" TEXT NOT NULL DEFAULT '[]',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationLog" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "audienceType" TEXT NOT NULL DEFAULT 'ALL',
    "audienceLabel" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "inAppNotified" BOOLEAN NOT NULL DEFAULT false,
    "sentBy" TEXT,
    "sentByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationRecipient" (
    "id" TEXT NOT NULL,
    "logId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "emailStatus" TEXT,
    "smsStatus" TEXT,
    "detail" TEXT,

    CONSTRAINT "CommunicationRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceCounter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SequenceCounter_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ApprovalDelegate" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "reason" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDelegate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PfEnrollment" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "enrollDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "employeePct" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "employerPct" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "basis" TEXT NOT NULL DEFAULT 'BASIC',
    "note" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PfEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PfContribution" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "employeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "employerAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'PAYROLL',
    "runId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PfContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AitFiscalYear" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "incomeYear" TEXT NOT NULL,
    "assessmentYear" TEXT NOT NULL,
    "tdsSectionRef" TEXT NOT NULL DEFAULT 'Section 86, Income Tax Act 2023',
    "exemptionFraction" DOUBLE PRECISION NOT NULL DEFAULT 0.3333333333,
    "exemptionCap" DOUBLE PRECISION NOT NULL DEFAULT 500000,
    "minimumTax" DOUBLE PRECISION NOT NULL DEFAULT 5000,
    "rebateRatePercent" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "rebateCapFraction" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "rebateCapAmount" DOUBLE PRECISION NOT NULL DEFAULT 10000000,
    "festivalBonusCount" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AitFiscalYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AitTaxpayerCategory" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AitTaxpayerCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AitTaxSlab" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "slabLabel" TEXT NOT NULL,
    "upperLimit" DOUBLE PRECISION,
    "ratePercent" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AitTaxSlab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AitCalculationLog" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fiscalYearId" TEXT,
    "employeeId" TEXT,
    "employeeCode" TEXT,
    "employeeName" TEXT,
    "kind" TEXT NOT NULL,
    "inputsJson" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "runId" TEXT,
    "operatorId" TEXT,
    "operatorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AitCalculationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "address" TEXT,
    "tin" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" TEXT,
    "address" TEXT,
    "keeperId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "reorderLevel" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransaction" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceAfter" DOUBLE PRECISION,
    "refType" TEXT,
    "refId" TEXT,
    "note" TEXT,
    "byUserId" TEXT,
    "byUserName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsRequisition" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "branchId" TEXT,
    "departmentId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "neededBy" TEXT,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalRequestId" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoodsRequisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsRequisitionItem" (
    "id" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "itemId" TEXT,
    "itemName" TEXT NOT NULL,
    "specification" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "issuedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remarks" TEXT,

    CONSTRAINT "GoodsRequisitionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsRequisitionHistory" (
    "id" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "byUserId" TEXT,
    "byUserName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsRequisitionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "requisitionId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalRequestId" TEXT,
    "purpose" TEXT,
    "totalValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "supplierId" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequestItem" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "itemId" TEXT,
    "itemName" TEXT NOT NULL,
    "specification" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "estimatedUnitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remarks" TEXT,

    CONSTRAINT "PurchaseRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseQuotation" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "quotationNo" TEXT,
    "quotationDate" TEXT,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deliveryTime" TEXT,
    "paymentTerms" TEXT,
    "deliveryCharge" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "validUntil" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseQuotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseQuotationItem" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "itemId" TEXT,
    "itemName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vatTax" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseQuotationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockEntry" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purchaseId" TEXT,
    "warehouseId" TEXT NOT NULL,
    "supplierId" TEXT,
    "invoiceNo" TEXT,
    "entryDate" TEXT NOT NULL,
    "remarks" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMP(3),
    "byUserId" TEXT,
    "byUserName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockEntryItem" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remarks" TEXT,

    CONSTRAINT "StockEntryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptConfirmation" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceiptConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BgJob" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "resultJson" TEXT,
    "error" TEXT,
    "createdBy" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BgJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Throttle" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Throttle_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "serialNumber" TEXT,
    "channel" INTEGER NOT NULL DEFAULT 1,
    "verificationCode" TEXT,
    "branchId" TEXT,
    "location" TEXT,
    "installDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastStatusCheckAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraCredential" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "encryptionKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "CameraCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_code_key" ON "Vendor"("code");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_vendorId_idx" ON "User"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "User_vendorId_email_key" ON "User"("vendorId", "email");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserMfaSecret_userId_key" ON "UserMfaSecret"("userId");

-- CreateIndex
CREATE INDEX "UserMfaSecret_vendorId_idx" ON "UserMfaSecret"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_vendorId_key_key" ON "Role"("vendorId", "key");

-- CreateIndex
CREATE INDEX "AuditLog_vendorId_createdAt_idx" ON "AuditLog"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_vendorId_entity_idx" ON "AuditLog"("vendorId", "entity");

-- CreateIndex
CREATE INDEX "Notification_vendorId_userId_idx" ON "Notification"("vendorId", "userId");

-- CreateIndex
CREATE INDEX "Notification_vendorId_employeeId_idx" ON "Notification"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "CompanyEvent_vendorId_date_idx" ON "CompanyEvent"("vendorId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalWorkflow_vendorId_processType_key" ON "ApprovalWorkflow"("vendorId", "processType");

-- CreateIndex
CREATE INDEX "ApprovalStep_workflowId_idx" ON "ApprovalStep"("workflowId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_vendorId_status_idx" ON "ApprovalRequest"("vendorId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_vendorId_processType_idx" ON "ApprovalRequest"("vendorId", "processType");

-- CreateIndex
CREATE INDEX "ApprovalAction_requestId_idx" ON "ApprovalAction"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "HrSetting_vendorId_group_key_key" ON "HrSetting"("vendorId", "group", "key");

-- CreateIndex
CREATE INDEX "Holiday_vendorId_date_idx" ON "Holiday"("vendorId", "date");

-- CreateIndex
CREATE INDEX "Branch_vendorId_idx" ON "Branch"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_vendorId_code_key" ON "Branch"("vendorId", "code");

-- CreateIndex
CREATE INDEX "Department_vendorId_idx" ON "Department"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_vendorId_code_key" ON "Department"("vendorId", "code");

-- CreateIndex
CREATE INDEX "Designation_vendorId_idx" ON "Designation"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Designation_vendorId_code_key" ON "Designation"("vendorId", "code");

-- CreateIndex
CREATE INDEX "Shift_vendorId_idx" ON "Shift"("vendorId");

-- CreateIndex
CREATE INDEX "ShiftAssignment_vendorId_employeeId_idx" ON "ShiftAssignment"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "ShiftAssignment_vendorId_fromDate_idx" ON "ShiftAssignment"("vendorId", "fromDate");

-- CreateIndex
CREATE INDEX "Employee_vendorId_status_idx" ON "Employee"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Employee_vendorId_branchId_idx" ON "Employee"("vendorId", "branchId");

-- CreateIndex
CREATE INDEX "Employee_vendorId_departmentId_idx" ON "Employee"("vendorId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_vendorId_code_key" ON "Employee"("vendorId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_vendorId_id_key" ON "Employee"("vendorId", "id");

-- CreateIndex
CREATE INDEX "FamilyMember_employeeId_idx" ON "FamilyMember"("employeeId");

-- CreateIndex
CREATE INDEX "Education_employeeId_idx" ON "Education"("employeeId");

-- CreateIndex
CREATE INDEX "Referee_employeeId_idx" ON "Referee"("employeeId");

-- CreateIndex
CREATE INDEX "PreviousEmployment_employeeId_idx" ON "PreviousEmployment"("employeeId");

-- CreateIndex
CREATE INDEX "BankAccount_employeeId_idx" ON "BankAccount"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_vendorId_employeeId_idx" ON "EmployeeDocument"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_vendorId_expiryDate_idx" ON "EmployeeDocument"("vendorId", "expiryDate");

-- CreateIndex
CREATE INDEX "EmployeeHistory_vendorId_employeeId_createdAt_idx" ON "EmployeeHistory"("vendorId", "employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "Promotion_vendorId_employeeId_idx" ON "Promotion"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "Transfer_vendorId_employeeId_idx" ON "Transfer"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "SalaryRevision_vendorId_employeeId_idx" ON "SalaryRevision"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "Attendance_vendorId_date_idx" ON "Attendance"("vendorId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_vendorId_employeeId_date_key" ON "Attendance"("vendorId", "employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDevice_deviceIdentifier_key" ON "AttendanceDevice"("deviceIdentifier");

-- CreateIndex
CREATE INDEX "AttendanceDevice_vendorId_enabled_idx" ON "AttendanceDevice"("vendorId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDevice_vendorId_deviceId_key" ON "AttendanceDevice"("vendorId", "deviceId");

-- CreateIndex
CREATE INDEX "AttendanceDeviceUser_vendorId_employeeId_idx" ON "AttendanceDeviceUser"("vendorId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDeviceUser_deviceId_deviceUserId_key" ON "AttendanceDeviceUser"("deviceId", "deviceUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRawEvent_payloadHash_key" ON "AttendanceRawEvent"("payloadHash");

-- CreateIndex
CREATE INDEX "AttendanceRawEvent_vendorId_deviceId_eventTime_idx" ON "AttendanceRawEvent"("vendorId", "deviceId", "eventTime");

-- CreateIndex
CREATE INDEX "AttendanceRawEvent_vendorId_employeeId_eventTime_idx" ON "AttendanceRawEvent"("vendorId", "employeeId", "eventTime");

-- CreateIndex
CREATE INDEX "AttendanceRawEvent_vendorId_processingStatus_idx" ON "AttendanceRawEvent"("vendorId", "processingStatus");

-- CreateIndex
CREATE INDEX "DeviceCommLog_vendorId_deviceId_createdAt_idx" ON "DeviceCommLog"("vendorId", "deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceCommLog_vendorId_createdAt_idx" ON "DeviceCommLog"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceCommand_vendorId_deviceId_status_idx" ON "DeviceCommand"("vendorId", "deviceId", "status");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_vendorId_status_idx" ON "AttendanceCorrection"("vendorId", "status");

-- CreateIndex
CREATE INDEX "QrToken_vendorId_token_idx" ON "QrToken"("vendorId", "token");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_vendorId_code_key" ON "LeaveType"("vendorId", "code");

-- CreateIndex
CREATE INDEX "LeaveBalance_vendorId_year_idx" ON "LeaveBalance"("vendorId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalance_employeeId_leaveTypeId_year_key" ON "LeaveBalance"("employeeId", "leaveTypeId", "year");

-- CreateIndex
CREATE INDEX "LeaveRequest_vendorId_status_idx" ON "LeaveRequest"("vendorId", "status");

-- CreateIndex
CREATE INDEX "LeaveRequest_vendorId_employeeId_idx" ON "LeaveRequest"("vendorId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveRequest_vendorId_id_key" ON "LeaveRequest"("vendorId", "id");

-- CreateIndex
CREATE INDEX "SalaryStructure_vendorId_employeeId_idx" ON "SalaryStructure"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollRun_vendorId_status_idx" ON "PayrollRun"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_vendorId_periodYear_periodMonth_periodWeek_runTy_key" ON "PayrollRun"("vendorId", "periodYear", "periodMonth", "periodWeek", "runType", "adjustSeq");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_vendorId_id_key" ON "PayrollRun"("vendorId", "id");

-- CreateIndex
CREATE INDEX "PayrollEntry_vendorId_employeeId_idx" ON "PayrollEntry"("vendorId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEntry_runId_employeeId_key" ON "PayrollEntry"("runId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEntry_vendorId_id_key" ON "PayrollEntry"("vendorId", "id");

-- CreateIndex
CREATE INDEX "TaxRuleSet_vendorId_idx" ON "TaxRuleSet"("vendorId");

-- CreateIndex
CREATE INDEX "TaxSlab_ruleSetId_idx" ON "TaxSlab"("ruleSetId");

-- CreateIndex
CREATE INDEX "TaxExemption_vendorId_idx" ON "TaxExemption"("vendorId");

-- CreateIndex
CREATE INDEX "SalaryTemplate_vendorId_idx" ON "SalaryTemplate"("vendorId");

-- CreateIndex
CREATE INDEX "Bonus_vendorId_status_idx" ON "Bonus"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Bonus_vendorId_employeeId_idx" ON "Bonus"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "Deduction_vendorId_status_idx" ON "Deduction"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Deduction_vendorId_employeeId_idx" ON "Deduction"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "Loan_vendorId_status_idx" ON "Loan"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Loan_vendorId_employeeId_idx" ON "Loan"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "Loan_vendorId_guarantorId_guarantorStatus_idx" ON "Loan"("vendorId", "guarantorId", "guarantorStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_vendorId_id_key" ON "Loan"("vendorId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoanInstallment_loanId_no_key" ON "LoanInstallment"("loanId", "no");

-- CreateIndex
CREATE INDEX "Advance_vendorId_status_idx" ON "Advance"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Advance_vendorId_employeeId_idx" ON "Advance"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "ExpenseClaim_vendorId_status_idx" ON "ExpenseClaim"("vendorId", "status");

-- CreateIndex
CREATE INDEX "ExpenseClaim_vendorId_employeeId_idx" ON "ExpenseClaim"("vendorId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountJournal_idempotencyKey_key" ON "AccountJournal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AccountJournal_vendorId_refType_idx" ON "AccountJournal"("vendorId", "refType");

-- CreateIndex
CREATE INDEX "AccountJournal_vendorId_date_idx" ON "AccountJournal"("vendorId", "date");

-- CreateIndex
CREATE INDEX "ReviewCycle_vendorId_idx" ON "ReviewCycle"("vendorId");

-- CreateIndex
CREATE INDEX "PerformanceReview_vendorId_employeeId_idx" ON "PerformanceReview"("vendorId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceReview_cycleId_employeeId_key" ON "PerformanceReview"("cycleId", "employeeId");

-- CreateIndex
CREATE INDEX "KpiTemplate_vendorId_idx" ON "KpiTemplate"("vendorId");

-- CreateIndex
CREATE INDEX "KpiAssignment_vendorId_employeeId_idx" ON "KpiAssignment"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "KpiAssignment_vendorId_status_idx" ON "KpiAssignment"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Task_vendorId_assigneeId_idx" ON "Task"("vendorId", "assigneeId");

-- CreateIndex
CREATE INDEX "Task_vendorId_status_idx" ON "Task"("vendorId", "status");

-- CreateIndex
CREATE INDEX "LetterTemplate_vendorId_type_idx" ON "LetterTemplate"("vendorId", "type");

-- CreateIndex
CREATE INDEX "HrLetter_vendorId_status_idx" ON "HrLetter"("vendorId", "status");

-- CreateIndex
CREATE INDEX "HrLetter_vendorId_employeeId_idx" ON "HrLetter"("vendorId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "HrLetter_vendorId_letterNumber_key" ON "HrLetter"("vendorId", "letterNumber");

-- CreateIndex
CREATE INDEX "Resignation_vendorId_status_idx" ON "Resignation"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Resignation_vendorId_employeeId_idx" ON "Resignation"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "CommissionRule_vendorId_idx" ON "CommissionRule"("vendorId");

-- CreateIndex
CREATE INDEX "ExitClearance_vendorId_idx" ON "ExitClearance"("vendorId");

-- CreateIndex
CREATE INDEX "FinalSettlement_vendorId_idx" ON "FinalSettlement"("vendorId");

-- CreateIndex
CREATE INDEX "Announcement_vendorId_active_idx" ON "Announcement"("vendorId", "active");

-- CreateIndex
CREATE INDEX "CommunicationLog_vendorId_createdAt_idx" ON "CommunicationLog"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunicationRecipient_logId_idx" ON "CommunicationRecipient"("logId");

-- CreateIndex
CREATE INDEX "ApprovalDelegate_vendorId_toUserId_active_idx" ON "ApprovalDelegate"("vendorId", "toUserId", "active");

-- CreateIndex
CREATE INDEX "ApprovalDelegate_vendorId_fromUserId_idx" ON "ApprovalDelegate"("vendorId", "fromUserId");

-- CreateIndex
CREATE INDEX "PfEnrollment_vendorId_status_idx" ON "PfEnrollment"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PfEnrollment_vendorId_employeeId_key" ON "PfEnrollment"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "PfContribution_vendorId_employeeId_periodYear_periodMonth_idx" ON "PfContribution"("vendorId", "employeeId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "PfContribution_vendorId_runId_idx" ON "PfContribution"("vendorId", "runId");

-- CreateIndex
CREATE INDEX "AitFiscalYear_vendorId_active_idx" ON "AitFiscalYear"("vendorId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AitTaxpayerCategory_fiscalYearId_key_key" ON "AitTaxpayerCategory"("fiscalYearId", "key");

-- CreateIndex
CREATE INDEX "AitTaxSlab_fiscalYearId_order_idx" ON "AitTaxSlab"("fiscalYearId", "order");

-- CreateIndex
CREATE INDEX "AitCalculationLog_vendorId_createdAt_idx" ON "AitCalculationLog"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "AitCalculationLog_vendorId_employeeId_idx" ON "AitCalculationLog"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "AitCalculationLog_vendorId_runId_idx" ON "AitCalculationLog"("vendorId", "runId");

-- CreateIndex
CREATE INDEX "Supplier_vendorId_idx" ON "Supplier"("vendorId");

-- CreateIndex
CREATE INDEX "Warehouse_vendorId_idx" ON "Warehouse"("vendorId");

-- CreateIndex
CREATE INDEX "Item_vendorId_category_idx" ON "Item"("vendorId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Item_vendorId_code_key" ON "Item"("vendorId", "code");

-- CreateIndex
CREATE INDEX "StockLevel_vendorId_idx" ON "StockLevel"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_itemId_warehouseId_key" ON "StockLevel"("itemId", "warehouseId");

-- CreateIndex
CREATE INDEX "StockTransaction_vendorId_itemId_createdAt_idx" ON "StockTransaction"("vendorId", "itemId", "createdAt");

-- CreateIndex
CREATE INDEX "StockTransaction_vendorId_warehouseId_idx" ON "StockTransaction"("vendorId", "warehouseId");

-- CreateIndex
CREATE INDEX "GoodsRequisition_vendorId_status_idx" ON "GoodsRequisition"("vendorId", "status");

-- CreateIndex
CREATE INDEX "GoodsRequisition_vendorId_employeeId_idx" ON "GoodsRequisition"("vendorId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsRequisition_vendorId_code_key" ON "GoodsRequisition"("vendorId", "code");

-- CreateIndex
CREATE INDEX "GoodsRequisitionItem_requisitionId_idx" ON "GoodsRequisitionItem"("requisitionId");

-- CreateIndex
CREATE INDEX "GoodsRequisitionHistory_requisitionId_createdAt_idx" ON "GoodsRequisitionHistory"("requisitionId", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_vendorId_status_idx" ON "PurchaseRequest"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_vendorId_code_key" ON "PurchaseRequest"("vendorId", "code");

-- CreateIndex
CREATE INDEX "PurchaseRequestItem_purchaseId_idx" ON "PurchaseRequestItem"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseQuotation_purchaseId_idx" ON "PurchaseQuotation"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseQuotationItem_quotationId_idx" ON "PurchaseQuotationItem"("quotationId");

-- CreateIndex
CREATE INDEX "StockEntry_vendorId_status_idx" ON "StockEntry"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockEntry_vendorId_code_key" ON "StockEntry"("vendorId", "code");

-- CreateIndex
CREATE INDEX "StockEntryItem_entryId_idx" ON "StockEntryItem"("entryId");

-- CreateIndex
CREATE INDEX "GoodsReceiptConfirmation_vendorId_requisitionId_idx" ON "GoodsReceiptConfirmation"("vendorId", "requisitionId");

-- CreateIndex
CREATE INDEX "BgJob_vendorId_status_idx" ON "BgJob"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BgJob_vendorId_id_key" ON "BgJob"("vendorId", "id");

-- CreateIndex
CREATE INDEX "Throttle_expiresAt_idx" ON "Throttle"("expiresAt");

-- CreateIndex
CREATE INDEX "Camera_vendorId_idx" ON "Camera"("vendorId");

-- CreateIndex
CREATE INDEX "Camera_vendorId_brand_idx" ON "Camera"("vendorId", "brand");

-- CreateIndex
CREATE INDEX "Camera_vendorId_branchId_idx" ON "Camera"("vendorId", "branchId");

-- CreateIndex
CREATE INDEX "Camera_vendorId_enabled_idx" ON "Camera"("vendorId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Camera_vendorId_id_key" ON "Camera"("vendorId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Camera_vendorId_serialNumber_channel_key" ON "Camera"("vendorId", "serialNumber", "channel");

-- CreateIndex
CREATE INDEX "CameraCredential_vendorId_idx" ON "CameraCredential"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "CameraCredential_vendorId_id_key" ON "CameraCredential"("vendorId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CameraCredential_vendorId_brand_key" ON "CameraCredential"("vendorId", "brand");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEntry" ADD CONSTRAINT "PayrollEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEntry" ADD CONSTRAINT "PayrollEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AitTaxpayerCategory" ADD CONSTRAINT "AitTaxpayerCategory_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "AitFiscalYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AitTaxSlab" ADD CONSTRAINT "AitTaxSlab_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "AitFiscalYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsRequisitionItem" ADD CONSTRAINT "GoodsRequisitionItem_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "GoodsRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestItem" ADD CONSTRAINT "PurchaseRequestItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseQuotationItem" ADD CONSTRAINT "PurchaseQuotationItem_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "PurchaseQuotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockEntryItem" ADD CONSTRAINT "StockEntryItem_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "StockEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateTable (manual addition — preserved from SQLite migration 20260921000300_h10_fk_integrity.
-- These FK-integrity safety-net tables exist in the production SQLite database but have no Prisma
-- model; they are carried into the PostgreSQL baseline so the migrated database is complete.
-- SQLite's CURRENT_TIMESTAMP is UTC; PostgreSQL's is session-timezone — the explicit
-- (now() AT TIME ZONE 'UTC') default preserves the original semantics exactly.)
CREATE TABLE IF NOT EXISTS "_archived_LeaveRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS "_archived_Loan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS "_archived_PayrollEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
