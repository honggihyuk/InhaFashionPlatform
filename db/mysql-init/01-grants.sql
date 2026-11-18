-- 앱 계정(inha)이 inha_* 스키마(운영/개발)와 테스트용 스키마를 만들고 쓸 수 있도록 권한 부여
GRANT ALL PRIVILEGES ON `inha\_%`.* TO 'inha'@'%';
GRANT ALL PRIVILEGES ON `t\_%`.* TO 'inha'@'%';
SET GLOBAL local_infile = 1;
FLUSH PRIVILEGES;
