/* ================================================================
   pm/templates.js — Project templates that create real work
   ----------------------------------------------------------------
   The whiteboard already ships 42 templates (templates.js). Every one
   of them draws shapes: a "Kanban board" template makes four frames
   and some sticky notes. Nothing is tracked, nothing is assignable,
   nothing has a due date.

   These templates create the other half — a status pipeline, lists,
   custom fields and a real task tree with dates, priorities,
   estimates and dependencies. `canvasTemplate` names the whiteboard
   template that pairs with each one, so choosing "Software sprint"
   can seed both the tasks and the sprint-planning canvas.

   Dates are relative (`day: 3` = three days after creation) so a
   template applied today produces a sensible schedule instead of
   dates from whenever the template was written.
   ================================================================ */

(function (global) {
  'use strict';

  const S = global.PMSchema;

  /* ------------------------------------------------------------------
     Task shorthand
       t(title, opts)   opts: { day, dur, prio, est, tag, list, status,
                                sub: [...], blocks: 'other task title' }
     ------------------------------------------------------------------ */

  function t(title, opts = {}) { return { title, ...opts }; }

  const TEMPLATES = {

    software_sprint: {
      name: 'Software sprint',
      icon: 'ph-code',
      color: '#4262ff',
      description: 'Two-week delivery cycle with grooming, build, review and release.',
      preset: 'software',
      canvasTemplate: 'sprint_planning',
      lists: ['Sprint backlog', 'Tech debt', 'Bugs'],
      fields: [
        { name: 'Story points', type: 'number' },
        { name: 'Component', type: 'select', options: ['Frontend', 'Backend', 'Infra', 'Mobile', 'Docs'] },
        { name: 'Needs QA', type: 'checkbox' },
      ],
      tags: ['sprint', 'blocked', 'quick-win'],
      tasks: [
        t('Sprint planning & capacity check', { day: 0, prio: 'high', est: 120, list: 0, sub: [
          t('Confirm who is on holiday'), t('Carry over unfinished work'), t('Agree the sprint goal'),
        ]}),
        t('Groom the backlog', { day: 1, prio: 'normal', est: 90, list: 0 }),
        t('Break epics into estimable stories', { day: 1, prio: 'normal', est: 120, list: 0, after: 'Groom the backlog' }),
        t('Build: highest-priority story', { day: 2, dur: 4, prio: 'urgent', est: 960, list: 0, after: 'Break epics into estimable stories' }),
        t('Build: second story', { day: 3, dur: 4, prio: 'high', est: 720, list: 0 }),
        t('Write tests for new code paths', { day: 5, dur: 2, prio: 'high', est: 240, list: 0 }),
        t('Code review round', { day: 7, dur: 2, prio: 'high', est: 180, list: 0, status: 'review', after: 'Build: highest-priority story' }),
        t('Fix review feedback', { day: 9, prio: 'normal', est: 180, list: 0, after: 'Code review round' }),
        t('QA pass on staging', { day: 10, dur: 2, prio: 'high', est: 240, list: 0, status: 'qa', after: 'Fix review feedback' }),
        t('Update the changelog and docs', { day: 11, prio: 'low', est: 60, list: 2 }),
        t('Release to production', { day: 12, prio: 'urgent', est: 90, list: 0, after: 'QA pass on staging' }),
        t('Sprint retro', { day: 13, prio: 'normal', est: 60, list: 0, after: 'Release to production' }),
        t('Pay down one piece of tech debt', { day: 6, prio: 'low', est: 240, list: 1 }),
      ],
    },

    product_launch: {
      name: 'Product launch',
      icon: 'ph-rocket-launch',
      color: '#e0455e',
      description: 'Everything between "we are shipping" and "it shipped", across every team.',
      preset: 'simple',
      canvasTemplate: 'roadmap',
      lists: ['Product', 'Marketing', 'Sales & support', 'Launch day'],
      fields: [
        { name: 'Owner team', type: 'select', options: ['Product', 'Engineering', 'Marketing', 'Sales', 'Support'] },
        { name: 'Launch blocker', type: 'checkbox' },
      ],
      tags: ['launch', 'blocker', 'nice-to-have'],
      tasks: [
        t('Lock the launch date', { day: 0, prio: 'urgent', est: 60, list: 0 }),
        t('Finalise the feature set', { day: 1, prio: 'urgent', est: 120, list: 0, after: 'Lock the launch date', sub: [
          t('Cut anything that will not be ready'), t('Confirm scope with engineering'),
        ]}),
        t('Write the positioning and messaging', { day: 2, dur: 3, prio: 'high', est: 300, list: 1, after: 'Finalise the feature set' }),
        t('Design the launch page', { day: 4, dur: 4, prio: 'high', est: 480, list: 1, after: 'Write the positioning and messaging' }),
        t('Record the demo video', { day: 6, dur: 2, prio: 'normal', est: 360, list: 1 }),
        t('Write the announcement blog post', { day: 7, dur: 2, prio: 'high', est: 240, list: 1 }),
        t('Draft the launch email sequence', { day: 8, prio: 'normal', est: 180, list: 1 }),
        t('Brief the support team', { day: 9, prio: 'high', est: 90, list: 2, sub: [
          t('Write the FAQ'), t('Set up canned responses'), t('Run a Q&A session'),
        ]}),
        t('Brief the sales team', { day: 9, prio: 'normal', est: 90, list: 2 }),
        t('Pricing and billing ready', { day: 5, prio: 'urgent', est: 240, list: 0 }),
        t('Final go / no-go review', { day: 12, prio: 'urgent', est: 60, list: 3, after: 'Design the launch page' }),
        t('Ship it', { day: 13, prio: 'urgent', est: 120, list: 3, after: 'Final go / no-go review' }),
        t('Monitor errors and feedback for 48h', { day: 13, dur: 2, prio: 'urgent', est: 240, list: 3, after: 'Ship it' }),
        t('Post-launch retro', { day: 17, prio: 'normal', est: 90, list: 3 }),
      ],
    },

    marketing_campaign: {
      name: 'Marketing campaign',
      icon: 'ph-megaphone',
      color: '#a855f7',
      description: 'Brief to results, with channels, assets and a reporting loop.',
      preset: 'content',
      canvasTemplate: 'user_journey',
      lists: ['Strategy', 'Creative', 'Channels', 'Measurement'],
      fields: [
        { name: 'Channel', type: 'select', options: ['Email', 'Social', 'Paid', 'SEO', 'Events', 'PR'] },
        { name: 'Budget', type: 'money' },
        { name: 'Target reach', type: 'number' },
      ],
      tags: ['campaign', 'asset', 'paid'],
      tasks: [
        t('Write the campaign brief', { day: 0, prio: 'urgent', est: 180, list: 0, sub: [
          t('Define the audience'), t('Set the single measurable goal'), t('Agree the budget'),
        ]}),
        t('Competitive and message research', { day: 1, dur: 3, prio: 'normal', est: 300, list: 0 }),
        t('Agree the creative concept', { day: 4, prio: 'high', est: 120, list: 1, after: 'Write the campaign brief' }),
        t('Produce the hero visual', { day: 5, dur: 4, prio: 'high', est: 600, list: 1, after: 'Agree the creative concept' }),
        t('Write all ad copy variants', { day: 6, dur: 3, prio: 'high', est: 300, list: 1 }),
        t('Build the landing page', { day: 8, dur: 4, prio: 'urgent', est: 720, list: 2 }),
        t('Set up tracking and UTMs', { day: 10, prio: 'urgent', est: 120, list: 3, after: 'Build the landing page' }),
        t('Schedule the social calendar', { day: 11, prio: 'normal', est: 180, list: 2 }),
        t('Set up the paid campaigns', { day: 12, prio: 'high', est: 240, list: 2, after: 'Write all ad copy variants' }),
        t('Send the launch email', { day: 14, prio: 'urgent', est: 90, list: 2, after: 'Set up tracking and UTMs' }),
        t('Week 1 performance review', { day: 21, prio: 'high', est: 90, list: 3, after: 'Send the launch email' }),
        t('Optimise the worst-performing channel', { day: 22, prio: 'normal', est: 240, list: 3 }),
        t('Final campaign report', { day: 35, prio: 'normal', est: 180, list: 3 }),
      ],
    },

    client_onboarding: {
      name: 'Client onboarding',
      icon: 'ph-handshake',
      color: '#17a673',
      description: 'A repeatable checklist from signed contract to first value delivered.',
      preset: 'simple',
      canvasTemplate: 'user_journey',
      lists: ['Paperwork', 'Setup', 'Training', 'Handover'],
      fields: [
        { name: 'Client name', type: 'text' },
        { name: 'Contract value', type: 'money' },
        { name: 'Go-live date', type: 'date' },
      ],
      tags: ['client', 'blocked-on-client'],
      tasks: [
        t('Countersign the contract', { day: 0, prio: 'urgent', est: 30, list: 0 }),
        t('Send the welcome pack', { day: 0, prio: 'high', est: 45, list: 0, after: 'Countersign the contract' }),
        t('Kickoff call', { day: 2, prio: 'urgent', est: 60, list: 0, sub: [
          t('Send the agenda 24h ahead'), t('Introduce the account team'), t('Agree success criteria'),
        ]}),
        t('Collect access credentials and data', { day: 3, dur: 4, prio: 'high', est: 120, list: 1, after: 'Kickoff call' }),
        t('Provision accounts and permissions', { day: 5, prio: 'high', est: 90, list: 1, after: 'Collect access credentials and data' }),
        t('Import their existing data', { day: 6, dur: 3, prio: 'high', est: 300, list: 1 }),
        t('Configure to their workflow', { day: 8, dur: 3, prio: 'normal', est: 360, list: 1 }),
        t('Run the admin training session', { day: 11, prio: 'high', est: 90, list: 2, after: 'Configure to their workflow' }),
        t('Run the end-user training session', { day: 13, prio: 'normal', est: 90, list: 2 }),
        t('Share the documentation pack', { day: 13, prio: 'low', est: 45, list: 2 }),
        t('Go-live check', { day: 15, prio: 'urgent', est: 60, list: 3, after: 'Run the admin training session' }),
        t('30-day check-in', { day: 45, prio: 'normal', est: 45, list: 3 }),
        t('Hand over to the success manager', { day: 46, prio: 'normal', est: 45, list: 3, after: '30-day check-in' }),
      ],
    },

    website_redesign: {
      name: 'Website redesign',
      icon: 'ph-browser',
      color: '#06b6d4',
      description: 'Audit, design, build and launch — with an SEO safety net.',
      preset: 'software',
      canvasTemplate: 'user_journey',
      lists: ['Discovery', 'Design', 'Build', 'Launch'],
      fields: [
        { name: 'Page', type: 'text' },
        { name: 'SEO risk', type: 'select', options: ['None', 'Low', 'High'] },
      ],
      tags: ['seo', 'accessibility', 'content'],
      tasks: [
        t('Audit the current site', { day: 0, dur: 3, prio: 'high', est: 480, list: 0, sub: [
          t('Export the full page inventory'), t('Record current traffic per page'), t('List what must not break'),
        ]}),
        t('Interview five users', { day: 2, dur: 5, prio: 'normal', est: 480, list: 0 }),
        t('Agree the new sitemap', { day: 6, prio: 'high', est: 180, list: 0, after: 'Audit the current site' }),
        t('Wireframe the key templates', { day: 8, dur: 4, prio: 'high', est: 600, list: 1, after: 'Agree the new sitemap' }),
        t('Visual design of the home page', { day: 12, dur: 4, prio: 'high', est: 720, list: 1, after: 'Wireframe the key templates' }),
        t('Design system: components and tokens', { day: 12, dur: 6, prio: 'normal', est: 900, list: 1 }),
        t('Build the component library', { day: 18, dur: 6, prio: 'high', est: 1200, list: 2, after: 'Design system: components and tokens' }),
        t('Build the page templates', { day: 24, dur: 6, prio: 'high', est: 1200, list: 2, after: 'Build the component library' }),
        t('Migrate the content', { day: 28, dur: 5, prio: 'normal', est: 900, list: 2 }),
        t('Set up 301 redirects for every old URL', { day: 32, prio: 'urgent', est: 240, list: 3, after: 'Audit the current site' }),
        t('Accessibility audit (WCAG AA)', { day: 33, dur: 2, prio: 'high', est: 300, list: 3 }),
        t('Performance pass — Core Web Vitals', { day: 34, dur: 2, prio: 'high', est: 300, list: 3 }),
        t('Launch', { day: 37, prio: 'urgent', est: 180, list: 3, after: 'Set up 301 redirects for every old URL' }),
        t('Watch rankings and errors for two weeks', { day: 38, dur: 14, prio: 'high', est: 300, list: 3, after: 'Launch' }),
      ],
    },

    event_planning: {
      name: 'Event planning',
      icon: 'ph-confetti',
      color: '#e8912b',
      description: 'Venue, speakers, promotion and run-of-show for an in-person or online event.',
      preset: 'simple',
      canvasTemplate: 'weekly_planner',
      lists: ['Logistics', 'Programme', 'Promotion', 'On the day'],
      fields: [
        { name: 'Vendor', type: 'text' },
        { name: 'Cost', type: 'money' },
        { name: 'Confirmed', type: 'checkbox' },
      ],
      tags: ['venue', 'speaker', 'catering'],
      tasks: [
        t('Set the date and budget', { day: 0, prio: 'urgent', est: 90, list: 0 }),
        t('Shortlist and book the venue', { day: 2, dur: 7, prio: 'urgent', est: 300, list: 0, after: 'Set the date and budget' }),
        t('Confirm catering', { day: 10, prio: 'high', est: 120, list: 0, after: 'Shortlist and book the venue' }),
        t('Invite and confirm speakers', { day: 3, dur: 14, prio: 'urgent', est: 480, list: 1, sub: [
          t('Draft the speaker invite'), t('Chase non-responders'), t('Collect bios and headshots'),
        ]}),
        t('Build the agenda', { day: 18, prio: 'high', est: 180, list: 1, after: 'Invite and confirm speakers' }),
        t('Open registration', { day: 12, prio: 'urgent', est: 240, list: 2, after: 'Shortlist and book the venue' }),
        t('Promotion push 1 — announcement', { day: 13, prio: 'high', est: 120, list: 2, after: 'Open registration' }),
        t('Promotion push 2 — speakers reveal', { day: 20, prio: 'normal', est: 120, list: 2 }),
        t('Promotion push 3 — last call', { day: 27, prio: 'high', est: 120, list: 2 }),
        t('Print badges and signage', { day: 28, prio: 'normal', est: 180, list: 0 }),
        t('Write the run of show', { day: 29, prio: 'urgent', est: 180, list: 3, after: 'Build the agenda' }),
        t('Tech rehearsal', { day: 30, prio: 'urgent', est: 180, list: 3, after: 'Write the run of show' }),
        t('Event day', { day: 31, prio: 'urgent', est: 600, list: 3, after: 'Tech rehearsal' }),
        t('Send thank-yous and the recording', { day: 33, prio: 'normal', est: 120, list: 3, after: 'Event day' }),
        t('Post-event survey and report', { day: 35, prio: 'normal', est: 180, list: 3 }),
      ],
    },

    content_calendar: {
      name: 'Content calendar',
      icon: 'ph-article',
      color: '#ec4899',
      description: 'A rolling pipeline from idea to published, with a research and edit stage.',
      preset: 'content',
      canvasTemplate: 'meeting_notes',
      lists: ['Blog', 'Newsletter', 'Video', 'Social'],
      fields: [
        { name: 'Target keyword', type: 'text' },
        { name: 'Word count', type: 'number' },
        { name: 'Published URL', type: 'url' },
      ],
      tags: ['evergreen', 'seasonal', 'seo'],
      tasks: [
        t('Quarterly content planning session', { day: 0, prio: 'high', est: 180, list: 0 }),
        t('Keyword and topic research', { day: 1, dur: 3, prio: 'high', est: 360, list: 0, after: 'Quarterly content planning session' }),
        t('Blog: pillar article', { day: 4, dur: 6, prio: 'high', est: 720, list: 0, after: 'Keyword and topic research', sub: [
          t('Outline'), t('First draft'), t('Add examples and screenshots'), t('Edit pass'), t('SEO check'),
        ]}),
        t('Blog: supporting article 1', { day: 8, dur: 3, prio: 'normal', est: 360, list: 0 }),
        t('Blog: supporting article 2', { day: 11, dur: 3, prio: 'normal', est: 360, list: 0 }),
        t('Newsletter: week 1', { day: 5, prio: 'normal', est: 120, list: 1 }),
        t('Newsletter: week 2', { day: 12, prio: 'normal', est: 120, list: 1 }),
        t('Video: script and storyboard', { day: 7, dur: 3, prio: 'normal', est: 300, list: 2 }),
        t('Video: record and edit', { day: 12, dur: 4, prio: 'normal', est: 600, list: 2, after: 'Video: script and storyboard' }),
        t('Repurpose the pillar into 5 social posts', { day: 14, prio: 'low', est: 180, list: 3, after: 'Blog: pillar article' }),
        t('Monthly performance review', { day: 30, prio: 'normal', est: 120, list: 0 }),
      ],
    },

    bug_triage: {
      name: 'Bug triage & support',
      icon: 'ph-bug',
      color: '#e0455e',
      description: 'An always-on queue with severity, reproduction and a weekly review.',
      preset: 'support',
      canvasTemplate: 'fishbone',
      lists: ['Inbox', 'Confirmed', 'Cannot reproduce'],
      fields: [
        { name: 'Severity', type: 'select', options: ['S1 — down', 'S2 — major', 'S3 — minor', 'S4 — cosmetic'] },
        { name: 'Affected users', type: 'number' },
        { name: 'Reproduction steps', type: 'text' },
        { name: 'Customer facing', type: 'checkbox' },
      ],
      tags: ['regression', 'data-loss', 'ui', 'performance'],
      tasks: [
        t('Set up the triage rota', { day: 0, prio: 'high', est: 60, list: 0 }),
        t('Agree severity definitions with support', { day: 0, prio: 'high', est: 90, list: 0 }),
        t('Daily triage sweep', { day: 1, prio: 'urgent', est: 45, list: 0, sub: [
          t('Reproduce every new report'), t('Set severity and owner'), t('Reply to the reporter'),
        ]}),
        t('Weekly bug review with engineering', { day: 5, prio: 'high', est: 60, list: 1 }),
        t('Fix the oldest S2', { day: 3, dur: 2, prio: 'high', est: 300, list: 1 }),
        t('Write a postmortem for the last S1', { day: 4, prio: 'high', est: 180, list: 1 }),
        t('Close out stale "cannot reproduce" tickets', { day: 7, prio: 'low', est: 60, list: 2 }),
        t('Monthly bug trend report', { day: 28, prio: 'normal', est: 120, list: 1 }),
      ],
    },

    hiring: {
      name: 'Hiring pipeline',
      icon: 'ph-user-plus',
      color: '#6366f1',
      description: 'One role from job description to signed offer, with every candidate stage.',
      preset: 'simple',
      canvasTemplate: 'org_chart',
      lists: ['Role setup', 'Sourcing', 'Interviews', 'Offer'],
      fields: [
        { name: 'Candidate', type: 'text' },
        { name: 'Source', type: 'select', options: ['Inbound', 'Referral', 'Agency', 'Outbound', 'Job board'] },
        { name: 'Stage rating', type: 'rating' },
      ],
      tags: ['referral', 'strong-yes', 'on-hold'],
      tasks: [
        t('Write the job description', { day: 0, prio: 'urgent', est: 180, list: 0, sub: [
          t('Define must-have vs nice-to-have'), t('Agree the salary band'), t('Get sign-off'),
        ]}),
        t('Design the interview loop', { day: 1, prio: 'high', est: 120, list: 0, after: 'Write the job description' }),
        t('Write the scorecard for each stage', { day: 2, prio: 'high', est: 120, list: 0, after: 'Design the interview loop' }),
        t('Post the role', { day: 3, prio: 'urgent', est: 60, list: 1, after: 'Write the job description' }),
        t('Ask the team for referrals', { day: 3, prio: 'high', est: 45, list: 1 }),
        t('Outbound sourcing — 25 profiles', { day: 4, dur: 7, prio: 'normal', est: 480, list: 1 }),
        t('Screen inbound applications', { day: 5, dur: 14, prio: 'high', est: 600, list: 1, after: 'Post the role' }),
        t('Phone screens', { day: 8, dur: 10, prio: 'high', est: 720, list: 2, after: 'Screen inbound applications' }),
        t('Technical / craft interviews', { day: 14, dur: 10, prio: 'high', est: 900, list: 2, after: 'Phone screens' }),
        t('Final panel and debrief', { day: 24, dur: 3, prio: 'urgent', est: 360, list: 2, after: 'Technical / craft interviews' }),
        t('Reference checks', { day: 27, prio: 'high', est: 120, list: 3, after: 'Final panel and debrief' }),
        t('Make the offer', { day: 28, prio: 'urgent', est: 60, list: 3, after: 'Reference checks' }),
        t('Plan their first week', { day: 30, prio: 'normal', est: 120, list: 3, after: 'Make the offer' }),
      ],
    },

    research_study: {
      name: 'Research study',
      icon: 'ph-flask',
      color: '#767f92',
      description: 'Question to insight: recruit, run, synthesise, share.',
      preset: 'simple',
      canvasTemplate: 'empathy_map',
      lists: ['Plan', 'Fieldwork', 'Synthesis', 'Share'],
      fields: [
        { name: 'Participant', type: 'text' },
        { name: 'Session date', type: 'date' },
        { name: 'Consent signed', type: 'checkbox' },
      ],
      tags: ['interview', 'survey', 'usability'],
      tasks: [
        t('Write the research question', { day: 0, prio: 'urgent', est: 90, list: 0 }),
        t('Choose the method', { day: 1, prio: 'high', est: 60, list: 0, after: 'Write the research question' }),
        t('Write the discussion guide', { day: 2, dur: 2, prio: 'high', est: 240, list: 0, after: 'Choose the method' }),
        t('Recruit 8 participants', { day: 3, dur: 7, prio: 'urgent', est: 480, list: 0, sub: [
          t('Write the screener'), t('Send invites'), t('Schedule and confirm'), t('Arrange incentives'),
        ]}),
        t('Pilot session', { day: 9, prio: 'high', est: 90, list: 1, after: 'Write the discussion guide' }),
        t('Run the sessions', { day: 10, dur: 7, prio: 'urgent', est: 960, list: 1, after: 'Pilot session' }),
        t('Transcribe and tag', { day: 13, dur: 5, prio: 'normal', est: 600, list: 2 }),
        t('Affinity mapping workshop', { day: 18, prio: 'high', est: 180, list: 2, after: 'Run the sessions' }),
        t('Write up the findings', { day: 19, dur: 3, prio: 'high', est: 480, list: 2, after: 'Affinity mapping workshop' }),
        t('Present to the team', { day: 23, prio: 'high', est: 120, list: 3, after: 'Write up the findings' }),
        t('Turn insights into backlog items', { day: 24, prio: 'normal', est: 180, list: 3, after: 'Present to the team' }),
      ],
    },
  };

  /* ------------------------------------------------------------------
     Application
     ------------------------------------------------------------------ */

  function isoIn(days) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + (days || 0));
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * Seed a project from a template.
   *
   * Runs inside one transaction, so applying a template is a single
   * undo step and one batched write instead of ~40.
   */
  function apply(store, projectId, templateId) {
    const tpl = TEMPLATES[templateId];
    const project = store.project(projectId);
    if (!tpl || !project) return null;

    return store.transact(`apply template: ${tpl.name}`, () => {
      // Lists first — tasks reference them by index.
      const lists = [];
      if (tpl.lists?.length) {
        // Reuse the project's default list as the first one rather than
        // leaving an empty "Tasks" list orphaned beside the new ones.
        const first = project.lists[0];
        if (first) {
          store.updateProject(projectId, {
            lists: project.lists.map(l => (l.id === first.id ? { ...l, name: tpl.lists[0] } : l)),
          });
          lists.push(first.id);
        }
        for (const name of tpl.lists.slice(lists.length)) {
          lists.push(store.addList(projectId, { name }).id);
        }
      }

      for (const f of tpl.fields || []) store.addCustomField(projectId, f);
      if (tpl.tags?.length) store.updateProject(projectId, { tags: [...new Set([...(project.tags || []), ...tpl.tags])] });
      if (tpl.icon || tpl.color) store.updateProject(projectId, { icon: tpl.icon, color: tpl.color });

      // Pass 1: create every task, remembering titles so `after` can be
      // resolved once all ids exist.
      const byTitle = new Map();
      for (const spec of tpl.tasks) {
        const created = store.createTask({
          projectId,
          title: spec.title,
          listId: lists[spec.list ?? 0] || null,
          priority: spec.prio || null,
          estimateMinutes: spec.est || null,
          statusId: spec.status || project.statuses[0].id,
          startDate: spec.day != null ? isoIn(spec.day) : null,
          dueDate: spec.day != null ? isoIn((spec.day || 0) + (spec.dur || 0)) : null,
          tags: spec.tag ? [spec.tag] : [],
        });
        byTitle.set(spec.title, created.id);

        for (const sub of spec.sub || []) {
          store.createTask({
            projectId, parentId: created.id, title: sub.title,
            listId: lists[spec.list ?? 0] || null,
            statusId: project.statuses[0].id,
          });
        }
      }

      // Pass 2: dependencies.
      for (const spec of tpl.tasks) {
        if (!spec.after) continue;
        const me = byTitle.get(spec.title);
        const up = byTitle.get(spec.after);
        if (me && up) store.addDependency(me, up, 'blocked_by');
      }

      store.updateProject(projectId, { description: project.description || tpl.description });
      return tpl;
    });
  }

  /**
   * Also draw the paired whiteboard template, if the canvas app is
   * loaded and the template exists there.
   */
  function applyCanvasCompanion(app, templateId) {
    const tpl = TEMPLATES[templateId];
    if (!tpl?.canvasTemplate || !app?.applyTemplate) return false;
    try { app.applyTemplate(tpl.canvasTemplate); return true; }
    catch (err) { console.debug('[pm] canvas companion template unavailable', err); return false; }
  }

  function list() {
    return Object.entries(TEMPLATES).map(([id, t]) => ({
      id, name: t.name, icon: t.icon, color: t.color,
      description: t.description, tasks: t.tasks,
      lists: t.lists || [], fields: t.fields || [],
      canvasTemplate: t.canvasTemplate || null,
      taskCount: t.tasks.length + t.tasks.reduce((n, x) => n + (x.sub?.length || 0), 0),
    }));
  }

  global.PMTemplates = { TEMPLATES, apply, applyCanvasCompanion, list, isoIn };

})(window);
