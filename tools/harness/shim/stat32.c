// i386 HLDS on a 64-bit-inode filesystem: 32-bit stat/readdir fail with EOVERFLOW. Route them through the 64-bit calls.
#define _GNU_SOURCE
#include <sys/stat.h>
#include <dirent.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
struct stat32 { unsigned long long st_dev; unsigned short __pad1; unsigned long st_ino; unsigned int st_mode, st_nlink, st_uid, st_gid;
  unsigned long long st_rdev; unsigned short __pad2; long st_size, st_blksize, st_blocks; struct timespec st_atim, st_mtim, st_ctim; unsigned long __u4, __u5; };
static int conv(int r, struct stat64 *s, void *out) {
  if (r) return r; struct stat32 *o = out; memset(o, 0, sizeof *o);
  o->st_dev = s->st_dev; o->st_ino = (unsigned long)s->st_ino; o->st_mode = s->st_mode; o->st_nlink = s->st_nlink;
  o->st_uid = s->st_uid; o->st_gid = s->st_gid; o->st_rdev = s->st_rdev; o->st_size = (long)s->st_size;
  o->st_blksize = s->st_blksize; o->st_blocks = (long)s->st_blocks; o->st_atim = s->st_atim; o->st_mtim = s->st_mtim; o->st_ctim = s->st_ctim;
  return 0; }
#include <stdio.h>
#include <stdlib.h>
static void trace(const char *what, const char *p) { static FILE *f; static int on = -1;
  if (on < 0) { const char *e = getenv("STAT32_TRACE"); on = e && *e; if (on) f = fopen(e, "a"); }
  if (on && f) { fprintf(f, "%s %s\n", what, p); fflush(f); } }
int __xstat(int v, const char *p, void *b) { struct stat64 s; trace("stat", p); return conv(fstatat64(AT_FDCWD, p, &s, 0), &s, b); }
int __lxstat(int v, const char *p, void *b) { struct stat64 s; return conv(fstatat64(AT_FDCWD, p, &s, AT_SYMLINK_NOFOLLOW), &s, b); }
int __fxstat(int v, int fd, void *b) { struct stat64 s; return conv(fstat64(fd, &s), &s, b); }
int s_stat(const char *p, void *b) { return __xstat(3, p, b); }
int s_lstat(const char *p, void *b) { return __lxstat(3, p, b); }
int s_fstat(int fd, void *b) { return __fxstat(3, fd, b); }
struct dirent32 { unsigned long d_ino; long d_off; unsigned short d_reclen; unsigned char d_type; char d_name[256]; };
static __thread struct dirent32 de;
void *s_readdir(DIR *d) { struct dirent64 *e = readdir64(d); if (!e) return 0;
  de.d_ino = (unsigned long)e->d_ino; de.d_off = (long)e->d_off; de.d_reclen = sizeof de; de.d_type = e->d_type;
  strncpy(de.d_name, e->d_name, 255); de.d_name[255] = 0;
  if (de.d_type == DT_UNKNOWN) { struct stat64 s;   // FUSE (Unraid shfs) leaves d_type unknown; AMXX trusts it to find subdirectories
    if (!fstatat64(dirfd(d), e->d_name, &s, AT_SYMLINK_NOFOLLOW)) de.d_type = S_ISDIR(s.st_mode) ? DT_DIR : S_ISREG(s.st_mode) ? DT_REG : S_ISLNK(s.st_mode) ? DT_LNK : DT_UNKNOWN; }
  return &de; }
__asm__(".globl stat\n.set stat, s_stat\n.globl lstat\n.set lstat, s_lstat\n.globl fstat\n.set fstat, s_fstat\n.globl readdir\n.set readdir, s_readdir");
