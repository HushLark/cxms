// ─────────────────────────────────────────────────────────────────────────────
// Moment Context — real-time "in the moment" variables for LLM context
// ─────────────────────────────────────────────────────────────────────────────

import { getEntityIndex } from '../index/entity-index.js';

export interface MomentContext {
    current_date: string;
    current_time: string;
    day_of_week: string;
    current_datetime_iso: string;
    user_timezone: string;
    overdue_tasks: number;
    tasks_due_today: number;
    tasks_due_tomorrow: number;
    todays_schedule: string;
}

export function buildMomentContext(_userName?: string): MomentContext {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

    const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const off = now.getTimezoneOffset();
    const sign = off <= 0 ? '+' : '-';
    const h = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
    const m = String(Math.abs(off) % 60).padStart(2, '0');
    const tzOffset = `${sign}${h}:${m}`;
    const isoWithTz = now.toISOString().replace('Z', tzOffset);

    const index = getEntityIndex();
    let overdueTasks = 0, tasksDueToday = 0, tasksDueTomorrow = 0;

    if (index.isBuilt) {
        const tasks = index.getNodes('task');
        for (const task of tasks) {
            const status = task.meta.status as string | undefined;
            if (status === 'done') continue;
            const dueDate = task.meta.dueDate as string | undefined;
            if (!dueDate) continue;
            const due = dueDate.slice(0, 10);
            if (due < today) overdueTasks++;
            else if (due === today) tasksDueToday++;
            else if (due === tomorrowStr) tasksDueTomorrow++;
        }
    }

    let todaysSchedule = 'No events scheduled today.';
    if (index.isBuilt) {
        const events = index.getNodes('event');
        const todayEvents: { time: string; title: string }[] = [];
        for (const event of events) {
            const startDate = (event.meta.startDate as string) || '';
            if (!startDate) continue;
            const eventDate = startDate.slice(0, 10);
            if (eventDate !== today) continue;
            const timePart = startDate.includes('T') ? startDate.slice(11, 16) : 'all-day';
            todayEvents.push({ time: timePart, title: event.title });
        }
        if (todayEvents.length > 0) {
            todayEvents.sort((a, b) => a.time.localeCompare(b.time));
            const lines = todayEvents.map(e => e.time === 'all-day' ? `${e.title} (all day)` : `${e.time} ${e.title}`);
            todaysSchedule = lines.join(', ');
        }
    }

    return {
        current_date: today, current_time: currentTime, day_of_week: dayOfWeek,
        current_datetime_iso: isoWithTz, user_timezone: `${userTimezone} (UTC${tzOffset})`,
        overdue_tasks: overdueTasks, tasks_due_today: tasksDueToday, tasks_due_tomorrow: tasksDueTomorrow,
        todays_schedule: todaysSchedule,
    };
}

export function formatMomentBlock(moment: MomentContext): string {
    return [
        `- current_date: ${moment.current_date} (${moment.day_of_week})`,
        `- current_time: ${moment.current_time}`,
        `- current_datetime: ${moment.current_datetime_iso}`,
        `- timezone: ${moment.user_timezone}`,
        `- overdue_tasks: ${moment.overdue_tasks}`,
        `- tasks_due_today: ${moment.tasks_due_today}`,
        `- tasks_due_tomorrow: ${moment.tasks_due_tomorrow}`,
        `- todays_schedule: ${moment.todays_schedule}`,
    ].join('\n');
}

export function momentToGlobals(moment: MomentContext, userName: string): Record<string, string> {
    return {
        user_name: userName,
        current_date: `${moment.current_date} (${moment.day_of_week})`,
        current_time: moment.current_time,
        current_datetime: moment.current_datetime_iso,
        timezone: moment.user_timezone,
        overdue_tasks: String(moment.overdue_tasks),
        tasks_due_today: String(moment.tasks_due_today),
        tasks_due_tomorrow: String(moment.tasks_due_tomorrow),
        todays_schedule: moment.todays_schedule,
    };
}
