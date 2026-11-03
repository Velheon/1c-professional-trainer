-- Aggregate counts only; does not read question texts or individual attempts.
select
  (select count(*) from public.bank_source) as banks,
  (select count(*) from public.sections) as sections,
  (select count(*) from public.questions) as questions,
  (select count(*) from public.answers) as answers,
  (select count(*) from storage.objects where bucket_id='question-images') as images,
  (select count(*) from public.attempts) as attempts;
