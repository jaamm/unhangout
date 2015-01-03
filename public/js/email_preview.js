require([
  'jquery', 'underscore', 'transport', 'auth', 'client-models', 'bootstrap'
], function($, _, transport, auth, models) {

    var curEvent = new models.ClientEvent(EVENT_ATTRS);
    var eventTitle = curEvent.get("title");
    var eventID = curEvent.id; 

    $(document).ready(function() { 
        $("#send-email").click(function() {
            $.ajax({
                type: 'POST',
                url: "/followup/event/" + curEvent.id + "/sent/",
                data: {eventTitle: eventTitle }
            }).fail(function(err) {
                console.log(err);
            });
        });

        $(".previous").click(function() {

            if(participantCount <= 1) {
                participantCount = 0;
                return; 
            }

            participantCount = participantCount - 1;

            window.location.reload();
            window.location.href = "/followup/event/" + eventID + 
                "/participant_" + participantCount; 
        });

        $(".next").click(function() {
            
            if(participantCount >= allUserIdsCount) {
                participantCount = allUserIdsCount; 
                return;
            }

            participantCount = participantCount + 1;

            window.location.reload();
            window.location.href = "/followup/event/" + eventID + 
                "/participant_" + participantCount; 
            
        });
    });

});
