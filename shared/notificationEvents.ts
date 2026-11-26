// Central notification event registry — the single list of every event the CRM can raise.
//
// Each event declares its category, the preference group users control it with, its default priority and channels,
// and whether it is mandatory (delivered regardless of personal preferences). Super Admins can override enabled /
// channels / priority / mandatory per event (notification_rules); everything else reads from here. New modules add
// their events here and call notify() with the key — no other wiring is needed.

export const CHANNELS = ['in_app', 'email', 'push'] as const
export type Channel = (typeof CHANNELS)[number]

export const NOTIFICATION_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number]

export const NOTIFICATION_CATEGORIES = {
  attendance: 'Attendance',
  task: 'Tasks',
  deadline: 'Task deadlines',
  task_comment: 'Task comments & replies',
  project: 'Projects',
  hr: 'HR & employees',
  leave: 'Leave',
  client: 'Clients',
  calendar: 'Calendar & meetings',
  file: 'Files & deliverables',
  team: 'Team & workload',
  report: 'Reports & digests',
  announcement: 'Announcements & messages',
  security: 'Security',
  system: 'System',
} as const
export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES

/** Preference groups. Stored in notifications.kind and notification_preferences.kind. */
export const PREFERENCE_GROUPS = {
  task_assigned: 'Task assignments',
  task_updates: 'Task changes and progress',
  task_due_soon: 'Task deadlines approaching',
  task_overdue: 'Overdue tasks',
  review_requested: 'Work awaiting your review',
  revision_requested: 'Revision requests',
  task_approved: 'Approved work',
  task_comment: 'Comments on your tasks',
  task_reply: 'Replies to your comments',
  mention: 'Mentions',
  project_update: 'Project updates',
  milestone_updated: 'Project milestones',
  client_feedback: 'Client feedback and approvals',
  client_updates: 'Client assignments and changes',
  attendance: 'Attendance reminders',
  leave_requested: 'Leave and attendance requests to approve',
  leave_decision: 'Leave and correction decisions',
  hr_update: 'HR and profile updates',
  calendar_changed: 'Meeting invitations and changes',
  meeting_reminder: 'Meeting reminders',
  file_update: 'Files and deliverables',
  announcement: 'Announcements and messages',
  report: 'Scheduled reports',
  digest: 'Daily and weekly digests',
  system: 'System alerts',
  security: 'Important security events',
} as const
export type PreferenceGroup = keyof typeof PREFERENCE_GROUPS

/** Groups that can never be muted by the recipient. */
export const LOCKED_GROUPS: PreferenceGroup[] = ['security']

export interface EventDef {
  label: string
  category: NotificationCategory
  group: PreferenceGroup
  priority: NotificationPriority
  channels: Channel[]
  /** Delivered regardless of recipient preferences (still subject to channel availability). */
  mandatory?: boolean
  /** Push and email bodies are replaced by a generic line (HR / personal data never leaves the CRM in clear). */
  sensitive?: boolean
  description: string
}

const A: Channel[] = ['in_app']
const AP: Channel[] = ['in_app', 'push']
const AE: Channel[] = ['in_app', 'email']
const AEP: Channel[] = ['in_app', 'email', 'push']

const ev = (
  label: string,
  category: NotificationCategory,
  group: PreferenceGroup,
  priority: NotificationPriority,
  channels: Channel[],
  description: string,
  extra: Partial<EventDef> = {},
): EventDef => ({ label, category, group, priority, channels, description, ...extra })

export const NOTIFICATION_EVENTS = {
  // ── Attendance
  ATTENDANCE_REMINDER: ev('Attendance reminder', 'attendance', 'attendance', 'normal', AP, 'Morning reminder to employees who have not checked in on a working day.'),
  ATTENDANCE_PRESENT: ev('Attendance recorded', 'attendance', 'attendance', 'low', A, 'Confirmation to the employee after checking in.'),
  ATTENDANCE_LATE: ev('Late arrival', 'attendance', 'attendance', 'normal', A, 'Check-in after the configured late threshold (employee and HR).'),
  ATTENDANCE_EARLY_DEPARTURE: ev('Early departure', 'attendance', 'attendance', 'normal', A, 'Check-out before the configured early-departure time (employee and HR).'),
  ATTENDANCE_MISSING: ev('Attendance missing', 'attendance', 'attendance', 'high', AEP, 'Employee has no check-in by the missing-attendance time. Not an absence until HR applies attendance rules.'),
  ATTENDANCE_CHECKOUT_REMINDER: ev('Checkout reminder', 'attendance', 'attendance', 'normal', AP, 'Evening reminder to employees who checked in but have not checked out.'),
  ATTENDANCE_MISSING_CHECKOUT: ev('Missing checkout', 'attendance', 'attendance', 'normal', AEP, 'Employee checked in but has no checkout by the detection time.'),
  ATTENDANCE_CORRECTION_REQUESTED: ev('Attendance correction requested', 'attendance', 'leave_requested', 'normal', AEP, 'An employee asked HR to correct an attendance record.'),
  ATTENDANCE_CORRECTION_APPROVED: ev('Attendance correction approved', 'attendance', 'leave_decision', 'normal', AEP, 'HR approved a correction request.'),
  ATTENDANCE_CORRECTION_REJECTED: ev('Attendance correction rejected', 'attendance', 'leave_decision', 'normal', AEP, 'HR rejected a correction request.'),
  ATTENDANCE_MODIFIED: ev('Attendance record modified', 'attendance', 'hr_update', 'normal', AE, 'HR edited an attendance record directly.'),
  ATTENDANCE_MISSING_REPORT: ev('Missing attendance report', 'attendance', 'report', 'high', AE, 'List of employees with no check-in, for HR.'),
  ATTENDANCE_EXCEPTION_REPORT: ev('Attendance exception report', 'attendance', 'report', 'normal', AE, 'Midday list of missing and late employees for HR, Admin and Super Admin.'),
  ATTENDANCE_MONTHLY_REPORT: ev('Monthly attendance report', 'attendance', 'report', 'normal', AE, 'Each employee’s own attendance summary for the previous month.'),

  // ── Task assignment & progress
  TASK_ASSIGNED: ev('Task assigned', 'task', 'task_assigned', 'normal', AEP, 'A task was assigned to the recipient (or to a project the recipient manages).'),
  TASK_REASSIGNED: ev('Task reassigned', 'task', 'task_assigned', 'normal', AEP, 'Responsibility for a task moved to the recipient.'),
  TASK_UNASSIGNED: ev('Removed from task', 'task', 'task_updates', 'low', A, 'The recipient is no longer responsible for or assigned to a task.'),
  TASK_UPDATED: ev('Task details changed', 'task', 'task_updates', 'low', A, 'Priority or description of a task the recipient works on changed.'),
  TASK_DEADLINE_CHANGED: ev('Task deadline changed', 'task', 'task_due_soon', 'normal', AP, 'The due date of the recipient’s task moved earlier or was removed.'),
  TASK_DEADLINE_EXTENDED: ev('Task deadline extended', 'task', 'task_due_soon', 'low', AP, 'The due date of the recipient’s task moved later.'),
  TASK_READY: ev('Task ready to start', 'task', 'task_assigned', 'normal', AP, 'Every dependency of the recipient’s task is complete.'),
  TASK_STARTED: ev('Task started', 'task', 'task_updates', 'low', A, 'Work started on a task the recipient manages.'),
  TASK_BLOCKED: ev('Task blocked', 'task', 'task_updates', 'high', AEP, 'A task in the recipient’s project is blocked.'),
  TASK_UNBLOCKED: ev('Task unblocked', 'task', 'task_updates', 'low', A, 'A blocked task resumed.'),
  TASK_SUBMITTED: ev('Task submitted for review', 'task', 'review_requested', 'normal', AEP, 'Work is waiting for the recipient’s review.'),
  TASK_APPROVED: ev('Task approved', 'task', 'task_approved', 'normal', AEP, 'The recipient’s submitted work was approved.'),
  TASK_REVISION_REQUESTED: ev('Revision requested', 'task', 'revision_requested', 'high', AEP, 'A reviewer asked for changes to the recipient’s work.'),
  TASK_COMPLETED: ev('Task completed', 'task', 'task_updates', 'normal', AE, 'A task the recipient manages or created was completed.'),
  TASK_REOPENED: ev('Task reopened', 'task', 'task_updates', 'normal', AP, 'A completed task was reopened.'),
  TASK_CANCELLED: ev('Task cancelled', 'task', 'task_updates', 'low', A, 'A task the recipient works on was cancelled.'),

  // ── Deadlines
  TASK_DEADLINE_TOMORROW: ev('Task due tomorrow', 'deadline', 'task_due_soon', 'normal', AEP, 'Reminder 24 hours before the due date.'),
  TASK_DEADLINE_TODAY: ev('Task due today', 'deadline', 'task_due_soon', 'high', AEP, 'Morning reminder on the due date.'),
  TASK_DEADLINE_2H: ev('Task due in 2 hours', 'deadline', 'task_due_soon', 'high', AP, 'Two hours before the end of the working day on the due date.'),
  TASK_DEADLINE_30M: ev('Task due in 30 minutes', 'deadline', 'task_due_soon', 'high', AP, 'Thirty minutes before the end of the working day on the due date.'),
  TASK_OVERDUE: ev('Task overdue', 'deadline', 'task_overdue', 'high', AEP, 'The recipient’s task (or a task in their project) is past due. Repeats up to the configured maximum.'),
  TASK_OVERDUE_ESCALATED: ev('Overdue task escalated', 'deadline', 'task_overdue', 'high', AE, 'A task has stayed overdue beyond the escalation interval.'),

  // ── Task discussion
  TASK_COMMENT_CREATED: ev('New task comment', 'task_comment', 'task_comment', 'normal', AEP, 'Someone commented on a task the recipient participates in.'),
  TASK_COMMENT_REPLIED: ev('Reply to your comment', 'task_comment', 'task_reply', 'normal', AEP, 'Someone replied to the recipient’s comment or a thread they joined.'),
  TASK_MENTIONED: ev('Mentioned in a comment', 'task_comment', 'mention', 'high', AEP, 'The recipient was @mentioned in a task discussion.'),
  TASK_ATTACHMENT_ADDED: ev('File added to task', 'task_comment', 'file_update', 'low', A, 'A file was attached to a task the recipient participates in.'),

  // ── Projects
  PROJECT_ASSIGNED: ev('Project assigned', 'project', 'project_update', 'high', AEP, 'The recipient became manager of a project.'),
  PROJECT_MEMBER_ADDED: ev('Added to project', 'project', 'project_update', 'normal', AEP, 'The recipient joined a project team.'),
  PROJECT_MEMBER_REMOVED: ev('Removed from project', 'project', 'project_update', 'normal', A, 'The recipient left a project team.'),
  PROJECT_STATUS_CHANGED: ev('Project status changed', 'project', 'project_update', 'normal', AP, 'A project the recipient works on changed status.'),
  PROJECT_DEADLINE_CHANGED: ev('Project deadline changed', 'project', 'project_update', 'normal', AE, 'The target date of the recipient’s project changed.'),
  PROJECT_UPDATE_POSTED: ev('Project update', 'project', 'project_update', 'normal', AEP, 'A project update was posted (internal or client-visible).'),
  PROJECT_UPDATE_PUBLISHED: ev('Project update published to client', 'project', 'project_update', 'low', A, 'An update was approved and published to the client portal.'),
  MILESTONE_CREATED: ev('Milestone created', 'project', 'milestone_updated', 'low', A, 'A milestone was added to the recipient’s project.'),
  MILESTONE_UPDATED: ev('Milestone updated', 'project', 'milestone_updated', 'normal', AP, 'A milestone changed status.'),
  MILESTONE_COMPLETED: ev('Milestone completed', 'project', 'milestone_updated', 'normal', AEP, 'A milestone was achieved.'),
  PROJECT_DELAYED: ev('Project delayed', 'project', 'project_update', 'high', AEP, 'A project passed its target date while still running.'),
  PROJECT_READY_FOR_REVIEW: ev('Project ready for review', 'project', 'review_requested', 'normal', AEP, 'Every task is complete; deliverables and closure need review.'),
  PROJECT_COMPLETED: ev('Project completed', 'project', 'project_update', 'normal', AE, 'A project was completed or closed.'),

  // ── HR & employees
  EMPLOYEE_CREATED: ev('New employee', 'hr', 'hr_update', 'normal', AE, 'A new user account was created.'),
  EMPLOYEE_PROFILE_UPDATED: ev('Employee profile updated', 'hr', 'hr_update', 'low', A, 'The recipient’s employee profile was edited.', { sensitive: true }),
  EMPLOYEE_DEPARTMENT_CHANGED: ev('Department changed', 'hr', 'hr_update', 'normal', AE, 'The recipient moved department (or joined the recipient’s department).'),
  EMPLOYEE_DESIGNATION_CHANGED: ev('Designation changed', 'hr', 'hr_update', 'normal', AE, 'The recipient’s designation changed.'),
  EMPLOYEE_MANAGER_CHANGED: ev('Reporting manager changed', 'hr', 'hr_update', 'normal', AE, 'The recipient’s reporting manager changed (or they gained a direct report).'),
  EMPLOYEE_ACCOUNT_STATUS: ev('Account activated or disabled', 'hr', 'hr_update', 'normal', AE, 'An employee account was deactivated or reactivated.'),
  EMPLOYEE_BIRTHDAY: ev('Birthday', 'hr', 'hr_update', 'low', A, 'Birthday reminder (the employee and HR).', { sensitive: true }),
  EMPLOYEE_ANNIVERSARY: ev('Work anniversary', 'hr', 'hr_update', 'low', A, 'Work anniversary reminder (the employee and HR).'),

  // ── Leave
  LEAVE_REQUESTED: ev('Leave requested', 'leave', 'leave_requested', 'normal', AEP, 'A leave request needs the recipient’s decision.', { sensitive: true }),
  LEAVE_APPROVED: ev('Leave approved', 'leave', 'leave_decision', 'normal', AEP, 'The recipient’s leave request was approved.'),
  LEAVE_REJECTED: ev('Leave rejected', 'leave', 'leave_decision', 'normal', AEP, 'The recipient’s leave request was rejected.'),
  LEAVE_CANCELLED: ev('Leave cancelled', 'leave', 'leave_requested', 'low', A, 'A pending or approved leave request was cancelled.'),
  LEAVE_UPCOMING: ev('Upcoming leave', 'leave', 'leave_decision', 'low', AE, 'Approved leave starts tomorrow (employee and reporting manager).'),
  LEAVE_TODAY: ev('Team member on leave', 'leave', 'leave_requested', 'low', A, 'A direct report is on approved leave today.'),

  // ── Clients
  CLIENT_CREATED: ev('New client', 'client', 'client_updates', 'low', A, 'A client or lead was added.'),
  CLIENT_ASSIGNED: ev('Client assigned', 'client', 'client_updates', 'normal', AEP, 'The recipient became account manager of a client.'),
  CLIENT_STATUS_CHANGED: ev('Client status changed', 'client', 'client_updates', 'low', A, 'A client the recipient manages changed status.'),
  CLIENT_INTERACTION_LOGGED: ev('Client communication logged', 'client', 'client_updates', 'low', A, 'A meeting, call or note was logged for the recipient’s client.'),
  CLIENT_FEEDBACK_RECEIVED: ev('Client feedback', 'client', 'client_feedback', 'high', AEP, 'Feedback, a question or a revision request arrived from the client portal.'),
  CLIENT_DELIVERABLE_DECISION: ev('Client approval decision', 'client', 'client_feedback', 'high', AEP, 'The client approved or requested changes to a shared deliverable.'),

  // ── Calendar
  MEETING_INVITATION: ev('Meeting invitation', 'calendar', 'calendar_changed', 'normal', AEP, 'The recipient was invited to a meeting or event.'),
  MEETING_UPDATED: ev('Meeting rescheduled or changed', 'calendar', 'calendar_changed', 'normal', AEP, 'A meeting the recipient attends changed.'),
  MEETING_CANCELLED: ev('Meeting cancelled', 'calendar', 'calendar_changed', 'normal', AEP, 'A meeting the recipient attends was cancelled.'),
  MEETING_ATTENDEE_REMOVED: ev('Removed from meeting', 'calendar', 'calendar_changed', 'low', A, 'The recipient is no longer an attendee.'),
  MEETING_REMINDER: ev('Meeting starting soon', 'calendar', 'meeting_reminder', 'high', AP, 'Reminder before a meeting starts (event reminder or the default lead time).'),

  // ── Files & deliverables
  DELIVERABLE_SUBMITTED: ev('Deliverable ready for review', 'file', 'review_requested', 'normal', AEP, 'A deliverable needs the recipient’s internal review.'),
  DELIVERABLE_APPROVED: ev('Deliverable approved', 'file', 'task_approved', 'normal', AE, 'The recipient’s deliverable was approved internally.'),
  DELIVERABLE_RETURNED: ev('Deliverable returned', 'file', 'revision_requested', 'normal', AEP, 'The recipient’s deliverable was returned to draft.'),
  DELIVERABLE_SHARED: ev('Deliverable shared with client', 'file', 'file_update', 'low', A, 'A deliverable was shared to the client portal.'),

  // ── Team & workload
  WORKLOAD_ALERT: ev('Workload alert', 'team', 'report', 'normal', AE, 'Weekly: people with excessive open or overdue work, and unassigned tasks.'),

  // ── Reports & digests
  DAILY_TASK_DIGEST: ev('Daily task summary', 'report', 'digest', 'low', AE, 'Each employee’s tasks for the day: due, pending, in progress, overdue, awaiting review.'),
  DAILY_HR_REPORT: ev('Daily HR report', 'report', 'report', 'normal', AE, 'Attendance, leave and exceptions for HR.'),
  DAILY_ADMIN_REPORT: ev('Daily operations report', 'report', 'report', 'normal', AE, 'Attendance overview, tasks, projects and alerts for Admin.'),
  DAILY_SUPER_ADMIN_REPORT: ev('Daily company report', 'report', 'report', 'normal', AE, 'Company-wide summary including delivery failures, for Super Admin.'),
  WEEKLY_REPORT: ev('Weekly report', 'report', 'report', 'normal', AE, 'Workload, project progress, overdue work, approvals and attendance for the past week.'),
  WEEKLY_EMPLOYEE_DIGEST: ev('Weekly digest', 'report', 'digest', 'low', AE, 'Each employee’s own week: completed, open and overdue tasks.'),
  MONTHLY_REPORT: ev('Monthly report', 'report', 'report', 'normal', AE, 'Attendance, leave, task completion and project performance for the previous month.'),

  // ── Announcements
  ANNOUNCEMENT_CREATED: ev('Announcement', 'announcement', 'announcement', 'normal', AEP, 'A company, department, team or role announcement.'),
  DIRECT_MESSAGE: ev('Message', 'announcement', 'announcement', 'normal', AEP, 'A message sent to selected people.'),
  ANNOUNCEMENT_ACK_REMINDER: ev('Acknowledgement reminder', 'announcement', 'announcement', 'high', AEP, 'Reminder to acknowledge an announcement.', { mandatory: true }),
  ANNOUNCEMENT_ACK_OVERDUE: ev('Announcement not acknowledged', 'announcement', 'announcement', 'normal', AE, 'A direct report has not acknowledged a required announcement.'),

  // ── Security
  SECURITY_ACCOUNT_LOCKED: ev('Account locked', 'security', 'security', 'critical', AEP, 'Repeated failed sign-ins locked the account.', { mandatory: true }),
  SECURITY_RECOVERY_CODE_USED: ev('Recovery code used', 'security', 'security', 'critical', AEP, 'A two-factor recovery code was used to sign in.', { mandatory: true }),
  SECURITY_PASSWORD_RESET_REQUESTED: ev('Password reset requested', 'security', 'security', 'high', AE, 'Someone asked administrators to reset their password.', { mandatory: true }),
  SECURITY_PASSWORD_CHANGED: ev('Password changed', 'security', 'security', 'critical', AE, 'The recipient’s password was changed or reset.', { mandatory: true }),
  SECURITY_NEW_LOGIN: ev('New sign-in', 'security', 'security', 'high', AE, 'Sign-in from a browser or device not seen before on the account.', { mandatory: true }),
  SECURITY_MFA_CHANGED: ev('Two-factor authentication changed', 'security', 'security', 'critical', AE, 'Two-factor authentication was enabled, disabled or reset.', { mandatory: true }),
  SECURITY_ROLE_CHANGED: ev('Role changed', 'security', 'security', 'high', AE, 'The recipient’s roles (and therefore permissions) changed.', { mandatory: true }),
  SECURITY_ADMIN_ADDED: ev('Administrator added', 'security', 'security', 'high', AE, 'An Admin or Super Admin role was granted.', { mandatory: true }),
  SECURITY_ROLE_PERMISSIONS_CHANGED: ev('Role permissions changed', 'security', 'security', 'normal', A, 'A role’s permissions were edited.', { mandatory: true }),
  SECURITY_SETTINGS_CHANGED: ev('Company settings changed', 'security', 'security', 'normal', A, 'A company setting was changed.', { mandatory: true }),

  // ── System
  SYSTEM_JOB_FAILED: ev('Scheduled job failed', 'system', 'system', 'high', A, 'A scheduled notification or report job threw an error.', { mandatory: true }),
  SYSTEM_EMAIL_PROVIDER_ERROR: ev('Email provider error', 'system', 'system', 'critical', A, 'Brevo rejected the API credentials or sender configuration.', { mandatory: true }),
  SYSTEM_TEST: ev('Test notification', 'system', 'system', 'normal', AEP, 'A test sent by an administrator or by the recipient to check a channel.', { mandatory: true }),
  SYSTEM_PUSH_ERROR: ev('Push delivery error', 'system', 'system', 'high', A, 'Web Push deliveries are failing (VAPID configuration or push service).', { mandatory: true }),
} satisfies Record<string, EventDef>

export type NotificationEventKey = keyof typeof NOTIFICATION_EVENTS
export const EVENT_KEYS = Object.keys(NOTIFICATION_EVENTS) as NotificationEventKey[]
export const isEventKey = (k: string): k is NotificationEventKey => Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENTS, k)

/** Legacy preference groups (pre-engine callers) → the event they meant. */
export const LEGACY_GROUP_EVENT: Partial<Record<string, NotificationEventKey>> = {
  task_assigned: 'TASK_ASSIGNED',
  task_due_soon: 'TASK_DEADLINE_TOMORROW',
  task_overdue: 'TASK_OVERDUE',
  review_requested: 'TASK_SUBMITTED',
  revision_requested: 'TASK_REVISION_REQUESTED',
  task_approved: 'TASK_APPROVED',
  milestone_updated: 'MILESTONE_UPDATED',
  client_feedback: 'CLIENT_FEEDBACK_RECEIVED',
  leave_decision: 'LEAVE_APPROVED',
  leave_requested: 'LEAVE_REQUESTED',
  calendar_changed: 'MEETING_UPDATED',
  security: 'SECURITY_NEW_LOGIN',
  mention: 'TASK_MENTIONED',
}

export const PRIORITY_LABEL: Record<NotificationPriority, string> = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' }
export const CHANNEL_LABEL: Record<Channel, string> = { in_app: 'In-app', email: 'Email', push: 'Push' }

/** Delivery states. "accepted" means Brevo took the message — it is not proof of delivery. */
export const DELIVERY_STATUSES = ['queued', 'sending', 'retry', 'accepted', 'sent', 'deferred', 'delivered', 'opened', 'clicked', 'failed', 'bounced', 'blocked', 'spam', 'unsubscribed', 'skipped'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]
export const FAILED_DELIVERY_STATUSES: DeliveryStatus[] = ['failed', 'bounced', 'blocked', 'spam']
