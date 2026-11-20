# How work flows in Visionary X Operations

A plain-language guide to how clients, projects and tasks move through the system, who does what, and what the software does for you automatically. The same guide is in the app under **Workflow guide** (`/guide`). Every project's Overview tab and every task page also shows a step tracker with the exact next step.

---

## 1. The big picture

```
 CLIENT ──► PLAN ──► DELIVER ──► SHARE ──► CLIENT APPROVES ──► CLOSE
 (CRM)      (PM)     (team)      (PM)      (client portal)      (PM)
```

| # | Stage | Who | What happens |
|---|---|---|---|
| 1 | **Client** | Account manager | Add the client and its contacts (Clients → New client). Record meetings, calls and requirements in *Relationship history*. |
| 2 | **Plan** | Project manager | Create the project for the client. Add the team, milestones and tasks. |
| 3 | **Deliver** | Team | Task owners do the work and submit it; reviewers approve it. Progress updates itself. |
| 4 | **Share** | Project manager | Upload deliverables, approve them internally, share them with the client, post client-visible updates. |
| 5 | **Client approves** | Client | The client opens their secure link, reviews deliverables, approves them or requests changes. |
| 6 | **Close** | Project manager | When every task is done and every deliverable approved, set the project to **Completed**. |

---

## 2. Setting up a project (project manager)

1. **Projects → New project.** Pick the client, the target deadline and how progress is counted:
   - *Weightage* (default): each task carries a % share of the project, set by the PM.
   - *Equal*: every task counts the same.
   - *Milestone*: each milestone has a weight.
2. **Team tab → Add people.** Choose each person's role:
   - *Lead*: can create and manage tasks.
   - *Member*: works on tasks.
   - *Viewer*: read-only.

   Tick **review authority** for anyone allowed to approve work.
3. **Milestones tab → Add milestone.** These are the checkpoints the client sees, such as "Design approved" or "Site live". Untick *Visible to the client* for internal ones.
4. **Board → New task.** For each task, set:
   - an **owner** (responsible person);
   - a **due date**;
   - an **estimate**;
   - its **weightage** — the % of the whole project it is worth;
   - **Count-based task** with *How many* + *Unit* if it is delivered in parts (e.g. 4 videos);
   - the **milestone** it belongs to;
   - and, if needed, **depends on** (the tasks that must finish first).

Leave *Requires review* on unless the task is trivial.

### How progress is calculated

Progress is never typed in. It is the sum of each task's share × how much of it is **approved**.

**Example 1 — website.** Client *Biotonic*, project *Biotonic web*:

| Task | Weightage | Status | Adds to project |
|---|---|---|---|
| Website layout | 20% | Approved | 20% |
| Inner pages | 30% | In review | 0% (not approved yet) |
| Changes & fixes | 20% | In progress | 0% |
| Launch | 30% | To do | 0% |
| **Project** | 100% | | **20%** |

When *Inner pages* is approved, the project jumps to **50%**.

**Example 2 — content.** The client needs 4 videos (task worth 40%). The editor finishes 2, clicks **Submit for review** and enters *2 videos*. Once approved, the task shows **2 / 4 videos (50%)** and adds **20%** (40% × 50%) to the project. It stays *In progress*; the editor uses **Submit next part** for the rest, and the task moves to *Done* when all 4 are approved. A reviewer can approve fewer than were submitted (e.g. 1 of 2) if one needs rework.

The project **Overview → How progress is calculated** panel lists every task's share, how much is done and what it adds. The PM can edit each share there; if the shares don't total 100% they are scaled automatically, and **Make it 100%** fixes them in one click.

> Tip: tasks you're not ready to schedule can go in **Backlog**. As soon as you give one an owner, it moves to **To do** automatically.

---

## 3. A task's life

```
 TO DO ──► IN PROGRESS ──► IN REVIEW ──► DONE
              │   ▲             │
              ▼   │             └── revisions requested ──► back to IN PROGRESS
           BLOCKED
```

| Step | Board column | Who acts | What to click |
|---|---|---|---|
| Planned | **To do** | Owner | **Start work** when you begin. |
| Working | **In progress** | Owner | Tick the checklist and **Log time**. When finished, **Submit for review** with a short note. |
| Stuck | **Blocked** | Owner | **Blocked** + say why (reviewers are notified). **Unblock** when resolved. |
| Waiting | **In review** | Reviewer | **Approve**, or **Request revisions** and explain what to change. |
| Done | **Completed** | — | Counts towards project progress (its full weightage). Count-based tasks also count each approved part before this. |

**Rules that keep things honest:**
- A reviewed task counts as done only once it is **approved**; submitting it isn't enough.
- A task can't be started or submitted while the tasks it depends on are unfinished.
- Nobody approves their own submission, unless they manage the project.
- Only project managers and leads can cancel tasks, reopen finished work, or edit details.
- Every status change, submission and decision is kept in the task's **History**.

**Where to look each day**
- **My work → Assigned to me**: your tasks, grouped into Overdue, Due today, Next 7 days and so on.
- **My work → Awaiting my review**: submissions you need to approve.
- **Overview**: your next tasks, your review queue, upcoming milestones and who's away today.
- **Bell icon**: new assignments, reviews, approvals and reminders. These also appear as live pop-ups.

---

## 4. Deliverables and the client

The deliverable flow is kept separate from task completion, so finishing tasks doesn't automatically send anything to the client.

```
 DRAFT ──► INTERNAL REVIEW ──► APPROVED ──► SHARED WITH CLIENT ──► CLIENT APPROVED
   ▲                                                    │
   └──────────────── changes requested ◄────────────────┘
```

1. **Deliverables tab → New deliverable**, then **Upload** a file. Each upload is a new version.
2. **Submit for review**: a reviewer **approves** it.
3. The project manager clicks **Share with client**. Only the latest approved version becomes visible on the portal.
4. The client approves or requests changes in the portal. Before approving, they confirm their email.
5. **Updates tab**: post progress notes. Only updates the PM publishes are visible to the client.
6. **Client feedback tab**: reply to the client's messages. Your reply appears in their portal.

**Giving a client access:** Client → **Portal access** → **Create link**. Choose one project or all of the client's projects, and how long the link stays valid. Copy the link and send it to the client yourself; it is shown only once. You can **Revoke** it at any time.

---

## 5. What the software does automatically

You don't need to update these statuses by hand. Admins can switch each rule off under **Settings → Automations**. Every automatic change appears in the project's **Activity** tab as "✦ Automation".

| When this happens… | …the software does this |
|---|---|
| A Backlog task gets an owner | Moves it to **To do** |
| The first task of a Planning / Not started project starts | Moves the project to **In progress** |
| The first task in a milestone starts | Moves the milestone to **In progress** |
| Every task in a milestone is approved | Marks the milestone **Achieved** and notifies the team (client sees it if the milestone is client-visible) |
| Everything a task depends on is complete | Moves it from Backlog to **To do** and sends its owner "Ready to start" |
| Every task in the project is complete | Moves the project to **In review** and asks the PM to approve deliverables and close it |
| Work is reopened or added after that | Moves the milestone / project back to **In progress** |
| A running project passes its target date (checked daily, 08:00 IST) | Marks it **Delayed** and notifies the PM |
| A task is due tomorrow / is overdue (daily) | Reminds the owner; managers get a weekly overdue notice |
| Any task status changes | Recalculates project progress, delivery health, and the dashboards for everyone viewing them (live) |

Things the software deliberately **doesn't** do automatically:
- Close a project.
- Share deliverables with the client.
- Approve anything.

Those always need a person's decision.

---

## 6. Project status at a glance

| Status | Meaning | How it's set |
|---|---|---|
| Planning / Not started | Being set up | PM |
| In progress | Work is happening | Automatically when work starts, or by the PM |
| At risk / On hold | Needs attention / paused | PM |
| Delayed | Past target date | Automatically each morning, or by the PM |
| In review | All tasks done; deliverables being approved | Automatically, or by the PM |
| Completed | Signed off | PM only; requires all tasks done and all deliverables approved |
| Archived | Hidden from active lists | PM / admin |

**Health** is shown separately from status: On track, Watch, At risk or Off track. It compares progress with the time elapsed and counts overdue and blocked work, and the reasons are always shown next to it.
