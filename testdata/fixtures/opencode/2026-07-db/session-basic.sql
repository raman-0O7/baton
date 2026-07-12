INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES
('ses_basic0000000000000000','prj_fake000','go-dir-listing','/home/user/project','Go directory listing question','1.2.3',1783000000000,1783000060000);
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
('msg_b1','ses_basic0000000000000000',1783000001000,1783000001000,'{"role":"user","path":{"cwd":"/home/user/project","root":"/home/user/project"}}'),
('msg_b2','ses_basic0000000000000000',1783000005000,1783000006000,'{"role":"assistant","mode":"build","path":{"cwd":"/home/user/project","root":"/home/user/project"},"tokens":{"input":12,"output":48}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
('prt_b1a','msg_b1','ses_basic0000000000000000',1783000001000,1783000001000,'{"type":"text","text":"How do I list files in a directory in Go?","time":{"start":1783000001000,"end":1783000001000}}'),
('prt_b2a','msg_b2','ses_basic0000000000000000',1783000005000,1783000006000,'{"type":"text","text":"Use os.ReadDir — it returns entries sorted by filename.","time":{"start":1783000005000,"end":1783000006000}}');
