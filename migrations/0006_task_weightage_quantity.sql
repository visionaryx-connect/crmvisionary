-- Task weightage and deliverable counts.
--  * tasks.weight is now entered as a percentage share of the project (e.g. 20 = 20%). Progress method 'effort'
--    is shown as "Weightage" and uses this share. Shares are scaled if they do not add up to exactly 100.
--  * Count-based tasks ("4 videos"): target_qty units, approved_qty of them approved so far. Each approval adds
--    the units in that submission; the task completes when approved_qty reaches target_qty. Partial approvals
--    count towards project progress proportionally (2 of 4 videos = half of that task's share).
ALTER TABLE tasks ADD COLUMN target_qty INTEGER CHECK (target_qty IS NULL OR target_qty >= 1);
ALTER TABLE tasks ADD COLUMN approved_qty INTEGER NOT NULL DEFAULT 0 CHECK (approved_qty >= 0);
ALTER TABLE tasks ADD COLUMN qty_unit TEXT NOT NULL DEFAULT '';
ALTER TABLE task_submissions ADD COLUMN qty INTEGER CHECK (qty IS NULL OR qty >= 1);
