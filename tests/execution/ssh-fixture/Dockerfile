FROM docker:29-dind
RUN apk add --no-cache openssh && ssh-keygen -A && mkdir -p /root/.ssh && chmod 700 /root/.ssh && passwd -d root
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["sh", "/entrypoint.sh"]
