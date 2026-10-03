#include <strings.h>
#include <ctype.h>
int stricmp(const char*a,const char*b){return strcasecmp(a,b);}
int strcmpi(const char*a,const char*b){return strcasecmp(a,b);}
int strnicmp(const char*a,const char*b,unsigned long n){return strncasecmp(a,b,n);}
