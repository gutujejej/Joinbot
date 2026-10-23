-- Optional sample data for the first connected bot. Run after you connected a bot. Safe to skip.
do $$
declare b bigint;
begin
  select id into b from jb_bots order by id limit 1;
  if b is null then
    raise notice 'Connect a bot first, then run this again.';
    return;
  end if;
  insert into jb_tasks (bot_id, type, title, description, reward, url, min_seconds, sort)
  values (b, 'visit', 'Read our guide', 'Open the page and wait 10 seconds.', 1, 'https://example.com', 10, 10);
  insert into jb_tasks (bot_id, type, title, description, reward, requires_review, sort)
  values (b, 'custom', 'Share our banner', 'Post it in a group and send the link as proof.', 5, true, 20);
  insert into jb_announcements (bot_id, title, body, pinned)
  values (b, 'Welcome', 'Complete tasks and earn ETB rewards. Rewards are promotional credits.', true);
end $$;
