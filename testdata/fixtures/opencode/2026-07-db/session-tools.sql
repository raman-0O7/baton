INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES
('ses_tools0000000000000000','prj_fake000','add-config-loader','/home/user/project','Add config loader','1.2.3',1783100000000,1783100120000);
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
('msg_t1','ses_tools0000000000000000',1783100001000,1783100001000,'{"role":"user","path":{"cwd":"/home/user/project","root":"/home/user/project"}}'),
('msg_t2','ses_tools0000000000000000',1783100010000,1783100030000,'{"role":"assistant","mode":"build","path":{"cwd":"/home/user/project","root":"/home/user/project"},"tokens":{"input":40,"output":200}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
('prt_t1a','msg_t1','ses_tools0000000000000000',1783100001000,1783100001000,'{"type":"text","text":"Create a config.go that loads settings from TOML.","time":{"start":1783100001000,"end":1783100001000}}'),
('prt_t2a','msg_t2','ses_tools0000000000000000',1783100010000,1783100012000,'{"type":"text","text":"Writing config.go now.","time":{"start":1783100010000,"end":1783100012000}}'),
('prt_t2b','msg_t2','ses_tools0000000000000000',1783100013000,1783100018000,'{"type":"tool","callID":"call_write_1","tool":"write","state":{"status":"completed","input":{"filePath":"/home/user/project/config.go","content":"package main\n"},"output":"File written","title":"write config.go"}}'),
('prt_t2c','msg_t2','ses_tools0000000000000000',1783100020000,1783100025000,'{"type":"tool","callID":"call_bash_1","tool":"bash","state":{"status":"completed","input":{"command":"go build ./..."},"output":"ok","title":"go build"}}');
