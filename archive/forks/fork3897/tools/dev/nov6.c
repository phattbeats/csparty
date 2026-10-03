// Dev-sandbox shim: kernel has no IPv6. Turn AF_INET6 sockets into AF_INET ones so steamclient can start.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <string.h>
#include <errno.h>
static int v4fd[4096];
int socket(int d,int t,int p){ static int(*r)(int,int,int); if(!r) r=dlsym(RTLD_NEXT,"socket");
  if(d==AF_INET6){ int fd=r(AF_INET,t,p); if(fd>=0&&fd<4096) v4fd[fd]=1; return fd; } return r(d,t,p); }
static void fix(const struct sockaddr*a, socklen_t l, struct sockaddr_in*o){ const struct sockaddr_in6*s=(const void*)a;
  memset(o,0,sizeof *o); o->sin_family=AF_INET; o->sin_port=s->sin6_port;
  if(IN6_IS_ADDR_V4MAPPED(&s->sin6_addr)) memcpy(&o->sin_addr,&s->sin6_addr.s6_addr[12],4); else o->sin_addr.s_addr=htonl(INADDR_ANY); }
int bind(int fd,const struct sockaddr*a,socklen_t l){ static int(*r)(int,const struct sockaddr*,socklen_t); if(!r) r=dlsym(RTLD_NEXT,"bind");
  if(a&&a->sa_family==AF_INET6){ struct sockaddr_in o; fix(a,l,&o); return r(fd,(void*)&o,sizeof o);} return r(fd,a,l); }
int connect(int fd,const struct sockaddr*a,socklen_t l){ static int(*r)(int,const struct sockaddr*,socklen_t); if(!r) r=dlsym(RTLD_NEXT,"connect");
  if(a&&a->sa_family==AF_INET6){ struct sockaddr_in o; fix(a,l,&o); return r(fd,(void*)&o,sizeof o);} return r(fd,a,l); }
ssize_t sendto(int fd,const void*b,size_t n,int f,const struct sockaddr*a,socklen_t l){ static ssize_t(*r)(int,const void*,size_t,int,const struct sockaddr*,socklen_t); if(!r) r=dlsym(RTLD_NEXT,"sendto");
  if(a&&a->sa_family==AF_INET6){ struct sockaddr_in o; fix(a,l,&o); return r(fd,b,n,f,(void*)&o,sizeof o);} return r(fd,b,n,f,a,l); }
int setsockopt(int fd,int lv,int on,const void*v,socklen_t l){ static int(*r)(int,int,int,const void*,socklen_t); if(!r) r=dlsym(RTLD_NEXT,"setsockopt");
  if(lv==IPPROTO_IPV6) return 0; return r(fd,lv,on,v,l); }
